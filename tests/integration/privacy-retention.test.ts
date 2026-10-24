import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { applyRetention, ERROR_REPORT_RETENTION_DAYS } from "@/server/privacy/retention";
import { eraseContactData, normalizePhoneDigits } from "@/server/privacy/erasure";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-10-23T03:30:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

/** Minimal rows written directly: these tests are about deletion, not how the rows were produced. */
async function seedOrganization(slug: string, settings: { transcriptRetentionDays?: number; leadRetentionDays?: number } = {}) {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug, ...settings } });
  const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: "Agent" } });
  const version = await prisma.agentVersion.create({ data: { agentId: agent.id, versionNumber: 1, instructions: "x" } });
  return { organization, agent, version };
}

type Seeded = Awaited<ReturnType<typeof seedOrganization>>;

async function conversationWithTranscript(seed: Seeded, createdAt: Date, text = "Hello") {
  const conversation = await prisma.conversation.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: seed.organization.id,
      agentId: seed.agent.id,
      agentVersionId: seed.version.id,
      channel: "EMBED",
      status: "COMPLETED",
      outcome: "ENGAGED",
      startedAt: createdAt,
      tokenIssuedAt: createdAt,
      endedAt: createdAt,
      transcriptConsent: true,
    },
  });
  await prisma.conversationTranscript.create({
    data: {
      conversationId: conversation.id,
      organizationId: seed.organization.id,
      entries: [{ role: "user", text }],
      entryCount: 1,
      summary: "A summary",
      createdAt,
    },
  });
  return conversation;
}

async function lead(seed: Seeded, createdAt: Date, fields: { email?: string; phone?: string; conversationId?: string } = {}) {
  return prisma.lead.create({
    data: { organizationId: seed.organization.id, agentId: seed.agent.id, name: "Visitor", createdAt, ...fields },
  });
}

describe("retention", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it("deletes transcripts and leads past each organization's own window, and nothing newer", async () => {
    const shortWindows = await seedOrganization("short", { transcriptRetentionDays: 7, leadRetentionDays: 30 });
    const defaults = await seedOrganization("defaults"); // 30 days / 365 days
    const oldShort = await conversationWithTranscript(shortWindows, daysAgo(8));
    const freshShort = await conversationWithTranscript(shortWindows, daysAgo(6));
    const eightDaysDefault = await conversationWithTranscript(defaults, daysAgo(8));
    const oldDefault = await conversationWithTranscript(defaults, daysAgo(31));
    await lead(shortWindows, daysAgo(31));
    const keptShortLead = await lead(shortWindows, daysAgo(29));
    const keptDefaultLead = await lead(defaults, daysAgo(200));
    await lead(defaults, daysAgo(366));

    const result = await applyRetention(NOW);

    expect(result).toMatchObject({ transcriptsDeleted: 2, leadsDeleted: 2 });
    const remainingTranscripts = await prisma.conversationTranscript.findMany({ select: { conversationId: true } });
    expect(remainingTranscripts.map((row) => row.conversationId).sort()).toEqual(
      [freshShort.id, eightDaysDefault.id].sort()
    );
    expect((await prisma.lead.findMany({ select: { id: true } })).map((row) => row.id).sort()).toEqual(
      [keptShortLead.id, keptDefaultLead.id].sort()
    );
    // Conversation records (no personal data) stay, so history and analytics remain accurate.
    expect(await prisma.conversation.count({ where: { id: { in: [oldShort.id, oldDefault.id] } } })).toBe(2);
  });

  it("writes one audit entry per organization and kind, with counts only", async () => {
    const seed = await seedOrganization("audited", { transcriptRetentionDays: 1 });
    await conversationWithTranscript(seed, daysAgo(2));
    await conversationWithTranscript(seed, daysAgo(3));

    await applyRetention(NOW);

    const entries = await prisma.auditLog.findMany({ where: { organizationId: seed.organization.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "retention.transcripts_deleted",
      actorUserId: null,
      metadata: { count: 2, retentionDays: 1 },
    });
  });

  it("is idempotent: a second run deletes nothing and logs nothing", async () => {
    const seed = await seedOrganization("twice", { transcriptRetentionDays: 1 });
    await conversationWithTranscript(seed, daysAgo(5));

    await applyRetention(NOW);
    const second = await applyRetention(NOW);

    expect(second).toMatchObject({ transcriptsDeleted: 0, leadsDeleted: 0 });
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it("prunes old monitoring records", async () => {
    await prisma.errorReport.createMany({
      data: [
        { fingerprint: "old", source: "route", message: "old", lastSeenAt: daysAgo(ERROR_REPORT_RETENTION_DAYS + 1) },
        { fingerprint: "new", source: "route", message: "new", lastSeenAt: daysAgo(1) },
      ],
    });
    await prisma.jobRun.create({
      data: { job: "retention", status: "SUCCEEDED", startedAt: daysAgo(100), finishedAt: daysAgo(100) },
    });

    const result = await applyRetention(NOW);

    expect(result).toMatchObject({ errorReportsDeleted: 1, jobRunsDeleted: 1 });
    expect((await prisma.errorReport.findMany()).map((row) => row.fingerprint)).toEqual(["new"]);
  });
});

describe("contact erasure", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("normalises phone numbers however they were typed", () => {
    expect(normalizePhoneDigits("+233 24 123 4567")).toBe("241234567");
    expect(normalizePhoneDigits("024-123-4567")).toBe("241234567");
    expect(normalizePhoneDigits("233241234567")).toBe("241234567");
    expect(normalizePhoneDigits("+44 7700 900123")).toBe("447700900123");
    expect(normalizePhoneDigits("12345")).toBeNull();
  });

  it("deletes the person's leads and related transcripts in one organization only", async () => {
    const mine = await seedOrganization("mine");
    const theirs = await seedOrganization("theirs");
    const linkedConversation = await conversationWithTranscript(mine, daysAgo(1));
    const mentioningConversation = await conversationWithTranscript(mine, daysAgo(1), "My email is AMA@Example.com");
    const unrelatedConversation = await conversationWithTranscript(mine, daysAgo(1), "Just browsing");
    await lead(mine, daysAgo(1), { email: "ama@example.com", conversationId: linkedConversation.id });
    await lead(mine, daysAgo(1), { phone: "+233 24 123 4567" });
    const otherPerson = await lead(mine, daysAgo(1), { email: "kojo@example.com", phone: "0209999999" });
    const otherTenant = await lead(theirs, daysAgo(1), { email: "ama@example.com", phone: "0241234567" });
    const otherTenantTranscript = await conversationWithTranscript(theirs, daysAgo(1), "ama@example.com");

    const result = await eraseContactData({
      organizationId: mine.organization.id,
      email: "Ama@Example.com",
      phone: "0241234567",
    });

    expect(result).toEqual({ leadsDeleted: 2, transcriptsDeleted: 2, callNumbersCleared: 0 });
    expect((await prisma.lead.findMany({ select: { id: true } })).map((row) => row.id).sort()).toEqual(
      [otherPerson.id, otherTenant.id].sort()
    );
    const transcripts = (await prisma.conversationTranscript.findMany({ select: { conversationId: true } })).map(
      (row) => row.conversationId
    );
    expect(transcripts.sort()).toEqual([unrelatedConversation.id, otherTenantTranscript.id].sort());
    expect(transcripts).not.toContain(mentioningConversation.id);
  });

  it("treats LIKE wildcards in an email literally", async () => {
    const seed = await seedOrganization("wildcards");
    await conversationWithTranscript(seed, daysAgo(1), "contact me at someone@example.com");

    const result = await eraseContactData({ organizationId: seed.organization.id, email: "%@example.com" });

    expect(result).toEqual({ leadsDeleted: 0, transcriptsDeleted: 0, callNumbersCleared: 0 });
    expect(await prisma.conversationTranscript.count()).toBe(1);
  });

  it("does nothing without a usable email or phone", async () => {
    const seed = await seedOrganization("nothing");
    await lead(seed, daysAgo(1), { phone: "12345" });

    expect(await eraseContactData({ organizationId: seed.organization.id, phone: "12345" })).toEqual({
      leadsDeleted: 0,
      transcriptsDeleted: 0,
      callNumbersCleared: 0,
    });
    expect(await prisma.lead.count()).toBe(1);
  });
});
