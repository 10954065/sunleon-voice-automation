import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { endVoiceSession, issueVoiceToken, prepareTestVoiceSession, recordLead } from "@/server/voice/session";
import { getAnalyticsReport } from "@/server/analytics/report";
import { applyRetention } from "@/server/privacy/retention";
import { fakeVoiceProvider, resetDatabase, seedVoiceOrganization } from "./helpers";

type Seed = Awaited<ReturnType<typeof seedVoiceOrganization>>;

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
// Two UTC days: late on the 19th and early on the 20th, to prove day bucketing uses UTC.
const DAY1_LATE = new Date("2026-10-19T23:59:00.000Z");
const DAY2_EARLY = new Date("2026-10-20T00:00:30.000Z");
const RANGE = { from: new Date("2026-10-18T00:00:00.000Z"), to: new Date("2026-10-21T00:00:00.000Z") };

/** One session through the real services. `lengthSeconds: null` = prepared but never connected. */
async function session(seed: Seed, at: Date, lengthSeconds: number | null, lead = false) {
  const prepared = await prepareTestVoiceSession({
    organizationId: seed.organization.id,
    organizationName: seed.organization.name,
    agentId: seed.agent.id,
    now: at,
  });
  if (lengthSeconds !== null) {
    await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeVoiceProvider, now: at });
  }
  await endVoiceSession({
    conversationId: prepared.conversationId,
    now: new Date(at.getTime() + (lengthSeconds ?? 0) * 1000),
  });
  if (lead) {
    await recordLead({ conversationId: prepared.conversationId, name: "Ama", phone: "0241234567" });
  }
  return prepared.conversationId;
}

describe("analytics", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.AI_GATEWAY_API_KEY = "placeholder-for-presence-check-only";
  });

  afterEach(() => {
    if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  });

  afterAll(async () => {
    await resetDatabase();
  });

  it("reports exactly what the recorded sessions, ledger and leads say", async () => {
    const seed = await seedVoiceOrganization("analytics", { planFrom: RANGE.from });
    await session(seed, DAY1_LATE, 120, true);
    await session(seed, DAY1_LATE, 10);
    await session(seed, DAY2_EARLY, 60);
    await session(seed, DAY2_EARLY, null);

    const report = await getAnalyticsReport({ organizationId: seed.organization.id, ...RANGE });

    expect(report.totals).toEqual({
      sessions: 4,
      connected: 3,
      voiceSeconds: 190,
      leadConversations: 1,
      inProgress: 0,
      averageConnectedSeconds: 63,
      leadRate: 1 / 3,
    });
    // The ledger is the source of truth for billed seconds; analytics must agree with it exactly.
    const ledger = await prisma.usageLedgerEntry.aggregate({
      where: { organizationId: seed.organization.id },
      _sum: { quantity: true },
    });
    expect(report.totals.voiceSeconds).toBe(ledger._sum.quantity);

    expect(report.daily).toEqual([
      { day: "2026-10-18", sessions: 0, connected: 0, voiceSeconds: 0, leadConversations: 0 },
      { day: "2026-10-19", sessions: 2, connected: 2, voiceSeconds: 130, leadConversations: 1 },
      { day: "2026-10-20", sessions: 2, connected: 1, voiceSeconds: 60, leadConversations: 0 },
    ]);
    expect(Object.fromEntries(report.outcomes.map((row) => [row.outcome, row.count]))).toEqual({
      LEAD_CAPTURED: 1,
      SHORT: 1,
      ENGAGED: 1,
      NOT_CONNECTED: 1,
    });
    expect(report.channels).toEqual({ TEST: 4, EMBED: 0 });
    expect(report.agents).toEqual([
      expect.objectContaining({ agentId: seed.agent.id, name: seed.agent.name, sessions: 4, voiceSeconds: 190 }),
    ]);
  });

  it("never includes another organization's sessions", async () => {
    const mine = await seedVoiceOrganization("mine", { planFrom: RANGE.from });
    const theirs = await seedVoiceOrganization("theirs", { planFrom: RANGE.from });
    await session(mine, DAY2_EARLY, 30);
    await session(theirs, DAY2_EARLY, 300, true);
    await session(theirs, DAY2_EARLY, 300);

    const report = await getAnalyticsReport({ organizationId: mine.organization.id, ...RANGE });

    expect(report.totals.sessions).toBe(1);
    expect(report.totals.voiceSeconds).toBe(30);
    expect(report.totals.leadConversations).toBe(0);
    expect(report.agents.map((row) => row.agentId)).toEqual([mine.agent.id]);
  });

  it("filters by agent, channel and range without leaking across them", async () => {
    const seed = await seedVoiceOrganization("filters", { planFrom: RANGE.from });
    const second = await prisma.agent.create({ data: { organizationId: seed.organization.id, name: "Second" } });
    await prisma.agentVersion.create({ data: { agentId: second.id, versionNumber: 1, instructions: "x" } });
    await session(seed, DAY1_LATE, 40);
    await session({ ...seed, agent: second }, DAY2_EARLY, 50);

    const byAgent = await getAnalyticsReport({ organizationId: seed.organization.id, ...RANGE, agentId: second.id });
    const embedOnly = await getAnalyticsReport({ organizationId: seed.organization.id, ...RANGE, channel: "EMBED" });
    const dayTwoOnly = await getAnalyticsReport({ organizationId: seed.organization.id, from: DAY2_EARLY, to: RANGE.to });

    expect(byAgent.totals).toMatchObject({ sessions: 1, voiceSeconds: 50 });
    expect(embedOnly.totals).toMatchObject({ sessions: 0, voiceSeconds: 0, averageConnectedSeconds: null, leadRate: null });
    expect(dayTwoOnly.totals).toMatchObject({ sessions: 1, voiceSeconds: 50 });
  });

  it("counts an active session as in progress, not as an outcome", async () => {
    const seed = await seedVoiceOrganization("live", { planFrom: RANGE.from });
    await prepareTestVoiceSession({
      organizationId: seed.organization.id,
      organizationName: seed.organization.name,
      agentId: seed.agent.id,
      now: DAY2_EARLY,
    });

    const report = await getAnalyticsReport({ organizationId: seed.organization.id, ...RANGE });

    expect(report.totals.inProgress).toBe(1);
    expect(report.outcomes).toEqual([{ outcome: "IN_PROGRESS", count: 1 }]);
  });

  it("keeps lead conversion after the leads themselves are deleted by retention", async () => {
    const seed = await seedVoiceOrganization("retained", { planFrom: RANGE.from });
    await session(seed, DAY1_LATE, 90, true);
    await prisma.lead.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });

    await applyRetention(new Date("2026-10-21T00:00:00.000Z"));

    expect(await prisma.lead.count()).toBe(0);
    const report = await getAnalyticsReport({ organizationId: seed.organization.id, ...RANGE });
    expect(report.totals.leadConversations).toBe(1);
  });
});
