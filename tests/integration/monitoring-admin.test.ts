import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { reportError } from "@/server/observability/errors";
import { runJob } from "@/server/observability/jobs";
import { getMonitoringSnapshot, listOrganizationsForAdmin } from "@/server/admin/overview";
import { listConversations, HISTORY_PAGE_SIZE, getConversationDetail } from "@/server/conversations/history";
import { listLeads } from "@/server/leads/queries";
import { listAuditLogs } from "@/server/audit/queries";
import { resetDatabase } from "./helpers";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const originalCronSecret = process.env.CRON_SECRET;

async function seedOrganization(slug: string) {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug } });
  const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: `Agent ${slug}` } });
  const version = await prisma.agentVersion.create({ data: { agentId: agent.id, versionNumber: 1, instructions: "x" } });
  return { organization, agent, version };
}

async function conversations(seed: Awaited<ReturnType<typeof seedOrganization>>, count: number, base = NOW) {
  for (let i = 0; i < count; i += 1) {
    await prisma.conversation.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: seed.organization.id,
        agentId: seed.agent.id,
        agentVersionId: seed.version.id,
        channel: i % 2 === 0 ? "EMBED" : "TEST",
        status: "COMPLETED",
        outcome: i % 3 === 0 ? "SHORT" : "ENGAGED",
        // Identical timestamps for some rows, so pagination must break ties by id.
        startedAt: new Date(base.getTime() - Math.floor(i / 2) * 60_000),
      },
    });
  }
}

describe("error reporting and jobs", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it("groups repeats of one error and scrubs personal data and secrets before storing", async () => {
    await reportError(new Error("Lookup failed for ama@example.com (row 17)"), { source: "route", route: "/api/x" }, NOW);
    await reportError(new Error("Lookup failed for kojo@example.com (row 42)"), { source: "route", route: "/api/x" }, NOW);
    await reportError(new Error("Auth: Bearer abc.def.ghi rejected, call +233 24 123 4567"), { source: "action" }, NOW);

    const reports = await prisma.errorReport.findMany({ orderBy: { occurrences: "desc" } });
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ occurrences: 2, route: "/api/x", message: "Error: Lookup failed for [email] (row 42)" });
    expect(reports[1]?.message).toBe("Error: Auth: Bearer [redacted] rejected, call [number]");
    expect(JSON.stringify(reports)).not.toMatch(/example\.com|abc\.def|4567/);
  });

  it("never throws, even when the error is not an Error", async () => {
    await expect(reportError("plain string failure", { source: "server" })).resolves.toBeUndefined();
    expect(await prisma.errorReport.count()).toBe(1);
  });

  it("records successful and failed job runs", async () => {
    const ok = await runJob("retention", async () => ({ deleted: 3 }));
    const failed = await runJob("retention", async () => {
      throw new Error("database timeout for ama@example.com");
    });

    expect(ok).toEqual({ ok: true, result: { deleted: 3 } });
    expect(failed).toEqual({ ok: false, error: "database timeout for [email]" });
    const runs = await prisma.jobRun.findMany({ orderBy: { startedAt: "asc" } });
    expect(runs.map((run) => run.status)).toEqual(["SUCCEEDED", "FAILED"]);
    expect(runs[0]?.details).toEqual({ deleted: 3 });
    expect(await prisma.errorReport.count({ where: { source: "job", route: "retention" } })).toBe(1);
  });

  it("protects both cron routes with CRON_SECRET and records their runs", async () => {
    const { GET: retention } = await import("@/app/api/cron/retention/route");
    const { GET: sweep } = await import("@/app/api/cron/sweep-sessions/route");
    const request = (secret: string | null) =>
      new NextRequest("http://localhost/api/cron/retention", {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });

    delete process.env.CRON_SECRET;
    expect((await retention(request("anything"))).status).toBe(503);
    process.env.CRON_SECRET = "cron-test-secret";
    expect((await retention(request(null))).status).toBe(401);
    expect((await sweep(request("wrong-secret-value"))).status).toBe(401);

    const response = await retention(request("cron-test-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcriptsDeleted: 0, leadsDeleted: 0, errorReportsDeleted: 0, jobRunsDeleted: 0 });
    expect((await sweep(request("cron-test-secret"))).status).toBe(200);
    expect((await prisma.jobRun.findMany()).map((run) => run.job).sort()).toEqual(["retention", "sweep-sessions"]);
  });

  it("summarises platform health from recorded rows", async () => {
    const seed = await seedOrganization("health");
    await prisma.conversation.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: seed.organization.id,
        agentId: seed.agent.id,
        agentVersionId: seed.version.id,
        channel: "EMBED",
        status: "ACTIVE",
        startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      },
    });
    await prisma.conversation.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: seed.organization.id,
        agentId: seed.agent.id,
        agentVersionId: seed.version.id,
        channel: "EMBED",
        status: "FAILED",
        outcome: "FAILED",
        endedAt: new Date(NOW.getTime() - 60_000),
        errorMessage: "upstream unavailable",
      },
    });
    await prisma.jobRun.create({
      data: { job: "retention", status: "SUCCEEDED", startedAt: new Date(NOW.getTime() - 60_000), finishedAt: NOW },
    });

    const snapshot = await getMonitoringSnapshot(NOW);

    expect(snapshot.database).toBe(true);
    expect(snapshot.stuckSessions).toBe(1);
    expect(snapshot.failedConversations24h).toBe(1);
    expect(snapshot.recentFailures[0]).toMatchObject({ errorMessage: "upstream unavailable", organization: { name: "Org health" } });
    expect(snapshot.jobs.find((job) => job.job === "retention")?.stale).toBe(false);
    expect(snapshot.jobs.find((job) => job.job === "sweep-sessions")?.stale).toBe(true);
  });
});

describe("admin and history listings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists organizations with counts and no customer content", async () => {
    const seed = await seedOrganization("listed");
    await conversations(seed, 3);

    const { rows } = await listOrganizationsForAdmin({ now: NOW });

    expect(rows).toEqual([
      expect.objectContaining({ slug: "listed", conversations30d: 3, agents: 1, plan: null, storesTranscripts: false }),
    ]);
    expect(Object.keys(rows[0] ?? {})).not.toContain("leads");
  });

  it("pages through conversation history without gaps or duplicates, inside one organization", async () => {
    const mine = await seedOrganization("history");
    const theirs = await seedOrganization("history-other");
    await conversations(mine, HISTORY_PAGE_SIZE + 7);
    await conversations(theirs, 5);
    const filters = { organizationId: mine.organization.id, from: new Date(0), to: new Date(NOW.getTime() + 1) };

    const first = await listConversations(filters);
    const second = await listConversations({ ...filters, cursor: first.nextCursor ?? undefined });

    expect(first.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second.rows).toHaveLength(7);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(HISTORY_PAGE_SIZE + 7);
    const ownIds = await prisma.conversation.findMany({ where: { organizationId: mine.organization.id }, select: { id: true } });
    expect(new Set(ids)).toEqual(new Set(ownIds.map((row) => row.id)));
  });

  it("applies outcome and channel filters, and treats another organization's cursor as a position only", async () => {
    const mine = await seedOrganization("filtered");
    const theirs = await seedOrganization("filtered-other");
    await conversations(mine, 6);
    await conversations(theirs, 6);
    const filters = { organizationId: mine.organization.id, from: new Date(0), to: new Date(NOW.getTime() + 1) };
    const foreignCursor = (await prisma.conversation.findFirstOrThrow({ where: { organizationId: theirs.organization.id } })).id;

    const short = await listConversations({ ...filters, outcome: "SHORT" });
    const embed = await listConversations({ ...filters, channel: "EMBED" });
    const withForeignCursor = await listConversations({ ...filters, cursor: foreignCursor });

    expect(short.rows.every((row) => row.outcome === "SHORT")).toBe(true);
    expect(short.rows).toHaveLength(2);
    expect(embed.rows.every((row) => row.channel === "EMBED")).toBe(true);
    expect(withForeignCursor.rows.every((row) => row.agentName === "Agent filtered")).toBe(true);
  });

  it("returns conversation detail only to its own organization", async () => {
    const mine = await seedOrganization("detail");
    const theirs = await seedOrganization("detail-other");
    await conversations(theirs, 1);
    const theirConversation = await prisma.conversation.findFirstOrThrow({ where: { organizationId: theirs.organization.id } });

    expect(await getConversationDetail(mine.organization.id, theirConversation.id)).toBeNull();
    expect(await getConversationDetail(theirs.organization.id, theirConversation.id)).not.toBeNull();
  });

  it("scopes leads and audit entries to the organization asked for", async () => {
    const mine = await seedOrganization("scoped");
    const theirs = await seedOrganization("scoped-other");
    await prisma.lead.create({ data: { organizationId: mine.organization.id, agentId: mine.agent.id, name: "Mine" } });
    await prisma.lead.create({ data: { organizationId: theirs.organization.id, agentId: theirs.agent.id, name: "Theirs" } });
    await prisma.auditLog.createMany({
      data: [
        { organizationId: mine.organization.id, action: "privacy.settings_updated" },
        { organizationId: theirs.organization.id, action: "privacy.settings_updated" },
        { organizationId: mine.organization.id, action: "export.leads" },
      ],
    });

    expect((await listLeads({ organizationId: mine.organization.id })).rows.map((lead) => lead.name)).toEqual(["Mine"]);
    expect((await listAuditLogs({ organizationId: mine.organization.id })).rows).toHaveLength(2);
    expect((await listAuditLogs({ organizationId: mine.organization.id, actionPrefix: "privacy." })).rows).toHaveLength(1);
    expect((await listAuditLogs({ organizationId: null })).rows).toHaveLength(3);
  });
});
