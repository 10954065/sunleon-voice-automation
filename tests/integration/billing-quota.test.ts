import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import {
  endVoiceSession,
  issueVoiceToken,
  prepareEmbedVoiceSession,
  prepareTestVoiceSession,
  VoiceSessionError,
} from "@/server/voice/session";
import type { RealtimeVoiceProvider } from "@/server/voice/provider";
import { createEmbedTicket } from "@/server/voice/embedTicket";
import { sweepStaleSessions } from "@/server/billing/sweeper";
import { getUsageSummary, VOICE_PROVIDER_ID } from "@/server/billing/usage";
import { REALTIME_VOICE_MODEL } from "@/lib/voice";
import { grantTestPlan, resetDatabase } from "./helpers";

/** Test double at the provider boundary only — these tests prove our metering, not a live Gateway session. */
const fakeProvider: RealtimeVoiceProvider = {
  mintToken: vi.fn(async () => ({ token: "vcst_test_double", url: "wss://gateway.invalid/realtime" })),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

async function seedOrg(slug: string, options: { createdDaysAgo?: number; publish?: boolean; domains?: string[] } = {}) {
  const createdAt = new Date(Date.now() - (options.createdDaysAgo ?? 0) * DAY_MS);
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug, createdAt } });
  const agent = await prisma.agent.create({
    data: { organizationId: organization.id, name: "Agent", allowedEmbedDomains: options.domains ?? [] },
  });
  const version = await prisma.agentVersion.create({
    data: { agentId: agent.id, versionNumber: 1, instructions: "Help.", publishedAt: options.publish ? new Date() : null },
  });
  if (options.publish) {
    await prisma.agent.update({ where: { id: agent.id }, data: { publishedVersionId: version.id } });
  }
  return { organization, agent };
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

function prepare(seed: Seed, now?: Date) {
  return prepareTestVoiceSession({
    organizationId: seed.organization.id,
    organizationName: seed.organization.name,
    agentId: seed.agent.id,
    now,
  });
}

/** Prepares, issues the token and returns the conversation id — a session that reached the provider. */
async function startSession(seed: Seed, now: Date) {
  const prepared = await prepare(seed, now);
  await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeProvider, now });
  return prepared;
}

async function recordUsage(seed: Seed, seconds: number, occurredAt = new Date()) {
  await prisma.usageLedgerEntry.create({
    data: {
      organizationId: seed.organization.id,
      agentId: seed.agent.id,
      metric: "VOICE_SECONDS",
      quantity: seconds,
      occurredAt,
      source: "server_clock",
      idempotencyKey: `test:${Math.random()}`,
    },
  });
}

describe("voice quota enforcement", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.AI_GATEWAY_API_KEY = "placeholder-for-presence-check-only";
  });

  afterEach(() => {
    if (originalGatewayKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
    }
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("reservations", () => {
    it("refuses with no plan (trial over, no subscription) and creates nothing", async () => {
      const seed = await seedOrg("expired", { createdDaysAgo: 30 });
      const error = await prepare(seed).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VoiceSessionError);
      expect((error as VoiceSessionError).status).toBe(402);
      expect((error as Error).message).toMatch(/no active plan/i);
      expect(await prisma.conversation.count()).toBe(0);
    });

    it("gives a new organization the trial: 10 minutes, one session at a time", async () => {
      const seed = await seedOrg("trial");
      const prepared = await prepare(seed);
      expect(prepared.maxDurationSeconds).toBe(600);
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: prepared.conversationId } });
      expect(conversation.reservedSeconds).toBe(600);

      const second = await prepare(seed).catch((e: unknown) => e);
      expect((second as VoiceSessionError).status).toBe(429);
    });

    it("caps a single reservation at the maximum session length", async () => {
      const seed = await seedOrg("big");
      await grantTestPlan(seed.organization.id, { includedMinutes: 1000 });
      expect((await prepare(seed)).maxDurationSeconds).toBe(900);
    });

    it("reserves only what is left and refuses once less than 30 seconds remain", async () => {
      const seed = await seedOrg("nearly-out");
      await grantTestPlan(seed.organization.id, { includedMinutes: 5 });
      await recordUsage(seed, 300 - 120);
      expect((await prepare(seed)).maxDurationSeconds).toBe(120);

      const exhausted = await seedOrg("out");
      await grantTestPlan(exhausted.organization.id, { includedMinutes: 1 });
      await recordUsage(exhausted, 40);
      const error = await prepare(exhausted).catch((e: unknown) => e);
      expect((error as VoiceSessionError).status).toBe(402);
      expect((error as Error).message).toMatch(/used up/i);
    });

    it("lets an approved overage budget extend the allowance, and no further", async () => {
      const seed = await seedOrg("overage");
      // GHS 1.00 per overage minute; owner approved GHS 5.00 → 5 extra minutes.
      await grantTestPlan(seed.organization.id, { includedMinutes: 1, overageRateMinorPerMinute: 100 });
      await prisma.organization.update({ where: { id: seed.organization.id }, data: { overageBudgetMinor: 500 } });
      await recordUsage(seed, 60);
      expect((await prepare(seed)).maxDurationSeconds).toBe(300);
    });

    it("ignores usage from previous billing periods", async () => {
      const seed = await seedOrg("rollover");
      await grantTestPlan(seed.organization.id, { includedMinutes: 2 });
      await recordUsage(seed, 120, new Date(Date.now() - 5 * DAY_MS));
      expect((await prepare(seed)).maxDurationSeconds).toBe(120);
    });

    it("shows public visitors a generic message, never the business's plan state", async () => {
      const seed = await seedOrg("public", { createdDaysAgo: 30, publish: true, domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });
      const error = await prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket }).catch((e: unknown) => e);
      expect((error as VoiceSessionError).status).toBe(402);
      expect((error as Error).message).toBe("This assistant is unavailable right now. Please try again later.");
    });
  });

  describe("concurrency", () => {
    it("never lets parallel requests exceed the plan's simultaneous-session limit", async () => {
      const seed = await seedOrg("parallel");
      await grantTestPlan(seed.organization.id, { maxConcurrentSessions: 2, includedMinutes: 1000 });

      const results = await Promise.allSettled(Array.from({ length: 6 }, () => prepare(seed)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      for (const rejected of results.filter((r) => r.status === "rejected")) {
        expect((rejected as PromiseRejectedResult).reason.status).toBe(429);
      }
      expect(await prisma.conversation.count({ where: { organizationId: seed.organization.id } })).toBe(2);
    });

    it("never lets parallel requests reserve more time than the allowance holds", async () => {
      const seed = await seedOrg("parallel-minutes");
      await grantTestPlan(seed.organization.id, { maxConcurrentSessions: 10, includedMinutes: 20 });

      const results = await Promise.allSettled(Array.from({ length: 6 }, () => prepare(seed)));
      const reserved = results
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof prepare>>> => r.status === "fulfilled")
        .map((r) => r.value.maxDurationSeconds);
      expect(reserved.reduce((sum, s) => sum + s, 0)).toBeLessThanOrEqual(1200);
      expect(reserved.sort((a, b) => b - a)).toEqual([900, 300]);
    });

    it("frees the slot of a prepared session nobody started after two minutes, without charging it", async () => {
      const seed = await seedOrg("unstarted");
      await grantTestPlan(seed.organization.id, { maxConcurrentSessions: 1 });
      const t0 = new Date();
      const first = await prepare(seed, t0);

      await expect(prepare(seed, new Date(t0.getTime() + 30_000))).rejects.toMatchObject({ status: 429 });
      await prepare(seed, new Date(t0.getTime() + 3 * 60_000));

      const closed = await prisma.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
      expect(closed).toMatchObject({ status: "COMPLETED", closeReason: "not_started" });
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    });
  });

  describe("usage ledger", () => {
    it("records exactly one ledger row however many times a session is ended, even concurrently", async () => {
      const seed = await seedOrg("idempotent");
      await grantTestPlan(seed.organization.id);
      const t0 = new Date();
      const { conversationId } = await startSession(seed, t0);
      const end = new Date(t0.getTime() + 61_000);

      await Promise.all(Array.from({ length: 5 }, () => endVoiceSession({ conversationId, reason: "user_ended", now: end })));
      await endVoiceSession({ conversationId, reason: "beacon", now: new Date(end.getTime() + 5_000) });

      const ledger = await prisma.usageLedgerEntry.findMany({ where: { conversationId } });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        quantity: 61,
        organizationId: seed.organization.id,
        agentId: seed.agent.id,
        idempotencyKey: `voice-session:${conversationId}`,
        provider: VOICE_PROVIDER_ID,
        model: REALTIME_VOICE_MODEL,
      });
      expect(await prisma.usageEvent.count({ where: { conversationId, type: "SESSION_ENDED" } })).toBe(1);
    });

    it("never bills past the reservation when the end report arrives late, but records what was measured", async () => {
      const seed = await seedOrg("late-end");
      await grantTestPlan(seed.organization.id, { includedMinutes: 5 });
      const t0 = new Date();
      const { conversationId, maxDurationSeconds } = await startSession(seed, t0);
      expect(maxDurationSeconds).toBe(300);

      await endVoiceSession({ conversationId, now: new Date(t0.getTime() + 3 * 60 * 60 * 1000) });

      expect((await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId } })).quantity).toBe(300);
      const ended = await prisma.usageEvent.findFirstOrThrow({ where: { conversationId, type: "SESSION_ENDED" } });
      expect(ended.metadata).toMatchObject({ chargedSeconds: 300, measuredSeconds: 3 * 60 * 60 });
    });

    it("rejects a second ledger row with the same idempotency key at the database level", async () => {
      const seed = await seedOrg("unique-key");
      const row = {
        organizationId: seed.organization.id,
        metric: "VOICE_SECONDS" as const,
        quantity: 10,
        occurredAt: new Date(),
        source: "server_clock",
        idempotencyKey: "voice-session:fixed",
      };
      await prisma.usageLedgerEntry.create({ data: row });
      await expect(prisma.usageLedgerEntry.create({ data: row })).rejects.toMatchObject({ code: "P2002" });
    });

    it("snapshots the estimated cost from the configured rate, and leaves it empty when none is set", async () => {
      const seed = await seedOrg("costed");
      await grantTestPlan(seed.organization.id);
      const t0 = new Date();

      const unpriced = await startSession(seed, t0);
      await endVoiceSession({ conversationId: unpriced.conversationId, now: new Date(t0.getTime() + 10_000) });

      await prisma.providerCostRate.create({
        data: { metric: "VOICE_SECONDS", provider: VOICE_PROVIDER_ID, model: REALTIME_VOICE_MODEL, microsPerUnit: 50_000, note: "test" },
      });
      const priced = await startSession(seed, t0);
      await endVoiceSession({ conversationId: priced.conversationId, now: new Date(t0.getTime() + 45_000) });

      const rows = await prisma.usageLedgerEntry.findMany({ orderBy: { quantity: "asc" } });
      expect(rows.map((r) => [r.quantity, r.estimatedCostMicros])).toEqual([
        [10, null],
        [45, 45 * 50_000],
      ]);
    });

    it("attributes usage to the right tenant and keeps summaries isolated", async () => {
      const a = await seedOrg("tenant-a");
      const b = await seedOrg("tenant-b");
      await grantTestPlan(a.organization.id);
      await grantTestPlan(b.organization.id);
      const t0 = new Date();

      const sessionA = await startSession(a, t0);
      const sessionB = await startSession(b, t0);
      await endVoiceSession({ conversationId: sessionA.conversationId, now: new Date(t0.getTime() + 30_000) });
      await endVoiceSession({ conversationId: sessionB.conversationId, now: new Date(t0.getTime() + 90_000) });

      expect((await getUsageSummary(a.organization.id)).usedSeconds).toBe(30);
      expect((await getUsageSummary(b.organization.id)).usedSeconds).toBe(90);
      const rowA = await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId: sessionA.conversationId } });
      expect(rowA).toMatchObject({ organizationId: a.organization.id, agentId: a.agent.id });
    });

    it("raises one warning and one exhausted alert per period, never duplicates", async () => {
      const seed = await seedOrg("alerts");
      await grantTestPlan(seed.organization.id, { includedMinutes: 10 });
      const t0 = new Date();

      const first = await startSession(seed, t0);
      await endVoiceSession({ conversationId: first.conversationId, now: new Date(t0.getTime() + 500_000) });
      expect(await prisma.usageAlert.findMany({ select: { kind: true } })).toEqual([{ kind: "THRESHOLD_WARNING" }]);

      const second = await startSession(seed, new Date(t0.getTime() + 600_000));
      await endVoiceSession({ conversationId: second.conversationId, now: new Date(t0.getTime() + 700_000) });
      const kinds = (await prisma.usageAlert.findMany({ orderBy: { kind: "asc" } })).map((a) => a.kind);
      expect(kinds).toEqual(["THRESHOLD_WARNING", "ALLOWANCE_EXHAUSTED"]);

      const summary = await getUsageSummary(seed.organization.id);
      expect(summary.warning).toBe("exhausted");
      expect(summary.remainingSeconds).toBe(0);
    });
  });

  describe("admin cost report", () => {
    it("reports usage, estimated cost, revenue and margin per organization, and flags unpriced usage", async () => {
      const priced = await seedOrg("priced");
      const unpriced = await seedOrg("unpriced");
      const plan = await grantTestPlan(priced.organization.id);
      await grantTestPlan(unpriced.organization.id);
      await prisma.usageLedgerEntry.create({
        data: {
          organizationId: priced.organization.id,
          metric: "VOICE_SECONDS",
          quantity: 600,
          occurredAt: new Date(),
          source: "server_clock",
          estimatedCostMicros: 600 * 50_000,
          idempotencyKey: "report:priced",
        },
      });
      await recordUsage(unpriced, 120);
      await prisma.billingTransaction.create({
        data: {
          organizationId: priced.organization.id,
          planId: plan.id,
          provider: "PAYSTACK",
          kind: "INITIAL",
          reference: "slv_report",
          status: "SUCCESS",
          amountMinor: 29900,
          currency: "GHS",
          paidAt: new Date(),
        },
      });

      const { getCostReport } = await import("@/server/billing/report");
      const rows = await getCostReport();
      const pricedRow = rows.find((row) => row.slug === "priced");
      const unpricedRow = rows.find((row) => row.slug === "unpriced");

      // GHS 299.00 revenue − GHS 30.00 estimated cost = GHS 269.00, in micro-GHS.
      expect(pricedRow).toMatchObject({ usedSeconds: 600, estimatedCostMicros: 30_000_000, revenueMinor: 29900, marginMicros: 269_000_000 });
      expect(unpricedRow).toMatchObject({ usedSeconds: 120, unpricedSeconds: 120, marginMicros: null });
    });
  });

  describe("sweeper", () => {
    it("closes an abandoned session, charges its full reservation once, and ignores live ones", async () => {
      const seed = await seedOrg("abandoned");
      // A separate organization: preparing a session also sweeps its own organization first,
      // which would close the abandoned session before the platform-wide sweep runs.
      const other = await seedOrg("still-talking");
      await grantTestPlan(seed.organization.id, { includedMinutes: 1000 });
      await grantTestPlan(other.organization.id);
      const t0 = new Date(Date.now() - 60 * 60 * 1000);
      const abandoned = await startSession(seed, t0);
      const live = await startSession(other, new Date());

      expect(await sweepStaleSessions()).toEqual({ closed: 1 });
      expect(await sweepStaleSessions()).toEqual({ closed: 0 });

      const closed = await prisma.conversation.findUniqueOrThrow({ where: { id: abandoned.conversationId } });
      expect(closed).toMatchObject({ status: "COMPLETED", closeReason: "abandoned" });
      const ledger = await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId: abandoned.conversationId } });
      expect(ledger).toMatchObject({ quantity: 900, source: "sweeper_reservation" });

      // A late end report after the sweep can't add a second charge.
      await endVoiceSession({ conversationId: abandoned.conversationId, reason: "late_beacon" });
      expect(await prisma.usageLedgerEntry.count({ where: { conversationId: abandoned.conversationId } })).toBe(1);

      const stillLive = await prisma.conversation.findUniqueOrThrow({ where: { id: live.conversationId } });
      expect(stillLive.status).toBe("ACTIVE");
    });

    it("also sweeps an organization's abandoned sessions when it next prepares one", async () => {
      const seed = await seedOrg("self-sweep");
      await grantTestPlan(seed.organization.id, { maxConcurrentSessions: 1 });
      const abandoned = await startSession(seed, new Date(Date.now() - 60 * 60 * 1000));

      await prepare(seed);

      const closed = await prisma.conversation.findUniqueOrThrow({ where: { id: abandoned.conversationId } });
      expect(closed.closeReason).toBe("abandoned");
    });
  });
});
