import "server-only";

import { prisma } from "@/server/db/client";
import { MAX_SESSION_SECONDS, REALTIME_VOICE_MODEL } from "@/lib/voice";
import { resolveEntitlements, type Db, type Entitlements } from "./entitlements";
import type { Conversation, Prisma } from "@/generated/prisma/client";

export const VOICE_PROVIDER_ID = "vercel-ai-gateway";
/** Matches the token route's window: a prepared session nobody started stops holding allowance after this. */
export const UNSTARTED_SESSION_TTL_MS = 2 * 60 * 1000;
/** Slack after a session's reservation runs out before the sweeper treats it as abandoned. */
export const STALE_GRACE_SECONDS = 2 * 60;
/** Ceiling for a single ledger row's cost snapshot (the column is a 32-bit integer). */
const MAX_COST_MICROS = 2_000_000_000;

export type UsageSource = "server_clock" | "sweeper_reservation";

type ConversationTiming = Pick<Conversation, "status" | "startedAt" | "tokenIssuedAt" | "reservedSeconds">;

/** Still holding allowance and a concurrency slot: prepared recently, or started and within its reservation. */
export function isLiveConversation(conversation: ConversationTiming, now: Date): boolean {
  if (conversation.status !== "ACTIVE") {
    return false;
  }
  if (!conversation.tokenIssuedAt) {
    return now.getTime() - conversation.startedAt.getTime() < UNSTARTED_SESSION_TTL_MS;
  }
  const limitSeconds = Math.min(conversation.reservedSeconds, MAX_SESSION_SECONDS) + STALE_GRACE_SECONDS;
  return now.getTime() - conversation.tokenIssuedAt.getTime() < limitSeconds * 1000;
}

export async function getPeriodUsageSeconds(db: Db, organizationId: string, start: Date, end: Date): Promise<number> {
  const result = await db.usageLedgerEntry.aggregate({
    where: { organizationId, metric: "VOICE_SECONDS", occurredAt: { gte: start, lt: end } },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

export async function getLiveSessions(
  db: Db,
  organizationId: string,
  now: Date
): Promise<{ count: number; reservedSeconds: number }> {
  // Concurrency caps keep this small; liveness needs per-row arithmetic, so filter in code.
  const active = await db.conversation.findMany({
    where: { organizationId, status: "ACTIVE" },
    select: { status: true, startedAt: true, tokenIssuedAt: true, reservedSeconds: true },
  });
  const live = active.filter((conversation) => isLiveConversation(conversation, now));
  return { count: live.length, reservedSeconds: live.reduce((sum, c) => sum + c.reservedSeconds, 0) };
}

async function estimateCostMicros(db: Db, seconds: number): Promise<number | null> {
  const rate = await db.providerCostRate.findUnique({
    where: {
      metric_provider_model: { metric: "VOICE_SECONDS", provider: VOICE_PROVIDER_ID, model: REALTIME_VOICE_MODEL },
    },
  });
  if (!rate) {
    return null;
  }
  return Math.min(rate.microsPerUnit * seconds, MAX_COST_MICROS);
}

/**
 * Atomically ends an ACTIVE conversation and records its usage. Only the caller that wins the
 * ACTIVE → COMPLETED claim writes anything, and the ledger's unique idempotency key backs that
 * up, so retried end requests, a beacon racing a button press, or the sweeper racing either can
 * never count a session twice. Returns false if the conversation was already closed.
 */
export async function settleConversation(
  tx: Prisma.TransactionClient,
  params: {
    conversation: Conversation;
    reason: string;
    chargedSeconds: number;
    source: UsageSource;
    now: Date;
    /** What our clock measured, when it differs from what is charged — kept for reconciliation. */
    measuredSeconds?: number;
    clientReportedSeconds?: number;
  }
): Promise<boolean> {
  const { conversation, now } = params;
  const claimed = await tx.conversation.updateMany({
    where: { id: conversation.id, status: "ACTIVE" },
    data: { status: "COMPLETED", endedAt: now, closeReason: params.reason },
  });
  if (claimed.count !== 1) {
    return false;
  }

  const chargedSeconds = conversation.tokenIssuedAt ? Math.max(0, Math.round(params.chargedSeconds)) : 0;

  await tx.usageEvent.create({
    data: {
      organizationId: conversation.organizationId,
      agentId: conversation.agentId,
      conversationId: conversation.id,
      type: "SESSION_ENDED",
      metadata: {
        reason: params.reason,
        chargedSeconds,
        usageSource: params.source,
        ...(params.measuredSeconds != null && { measuredSeconds: params.measuredSeconds }),
        ...(params.clientReportedSeconds != null && { clientReportedSeconds: params.clientReportedSeconds }),
      },
    },
  });

  // A session whose token was never issued never reached the provider: nothing to bill.
  if (!conversation.tokenIssuedAt) {
    return true;
  }

  await tx.usageLedgerEntry.create({
    data: {
      organizationId: conversation.organizationId,
      agentId: conversation.agentId,
      conversationId: conversation.id,
      metric: "VOICE_SECONDS",
      quantity: chargedSeconds,
      occurredAt: conversation.tokenIssuedAt,
      source: params.source,
      provider: VOICE_PROVIDER_ID,
      model: REALTIME_VOICE_MODEL,
      estimatedCostMicros: await estimateCostMicros(tx, chargedSeconds),
      idempotencyKey: `voice-session:${conversation.id}`,
    },
  });

  await raiseUsageAlerts(tx, conversation.organizationId, now);
  return true;
}

/** Creates at most one warning and one exhausted alert per organization per billing period. */
export async function raiseUsageAlerts(db: Db, organizationId: string, now: Date): Promise<void> {
  const entitlements = await resolveEntitlements(db, organizationId, now);
  if (!entitlements.periodStart || !entitlements.periodEnd || entitlements.includedSeconds <= 0) {
    return;
  }
  const used = await getPeriodUsageSeconds(db, organizationId, entitlements.periodStart, entitlements.periodEnd);
  const kinds = alertKindsFor(used, entitlements);
  if (kinds.length === 0) {
    return;
  }
  await db.usageAlert.createMany({
    data: kinds.map((kind) => ({
      organizationId,
      kind,
      periodStart: entitlements.periodStart as Date,
      usedSeconds: used,
      allowanceSeconds: entitlements.includedSeconds,
    })),
    skipDuplicates: true,
  });
}

export function alertKindsFor(
  usedSeconds: number,
  entitlements: Pick<Entitlements, "includedSeconds" | "warningThresholdPercent">
): Array<"THRESHOLD_WARNING" | "ALLOWANCE_EXHAUSTED"> {
  const kinds: Array<"THRESHOLD_WARNING" | "ALLOWANCE_EXHAUSTED"> = [];
  if (usedSeconds * 100 >= entitlements.includedSeconds * entitlements.warningThresholdPercent) {
    kinds.push("THRESHOLD_WARNING");
  }
  if (usedSeconds >= entitlements.includedSeconds) {
    kinds.push("ALLOWANCE_EXHAUSTED");
  }
  return kinds;
}

export interface UsageSummary {
  entitlements: Entitlements;
  usedSeconds: number;
  liveSessions: number;
  reservedSeconds: number;
  /** Included plus approved overage, minus used and reserved. Never negative. */
  remainingSeconds: number;
  overageSeconds: number;
  /** Overage charge implied by this period's usage, capped at the approved budget. */
  overageChargeMinor: number;
  estimatedCostMicros: number;
  /** Seconds recorded with no cost rate configured, so the cost estimate is incomplete. */
  unpricedSeconds: number;
  percentUsed: number;
  warning: "none" | "approaching" | "exhausted";
}

export async function getUsageSummary(organizationId: string, now: Date = new Date()): Promise<UsageSummary> {
  const entitlements = await resolveEntitlements(prisma, organizationId, now);
  const live = await getLiveSessions(prisma, organizationId, now);

  let usedSeconds = 0;
  let estimatedCostMicros = 0;
  let unpricedSeconds = 0;
  if (entitlements.periodStart && entitlements.periodEnd) {
    const range = { gte: entitlements.periodStart, lt: entitlements.periodEnd };
    const [all, unpriced] = await Promise.all([
      prisma.usageLedgerEntry.aggregate({
        where: { organizationId, metric: "VOICE_SECONDS", occurredAt: range },
        _sum: { quantity: true, estimatedCostMicros: true },
      }),
      prisma.usageLedgerEntry.aggregate({
        where: { organizationId, metric: "VOICE_SECONDS", occurredAt: range, estimatedCostMicros: null },
        _sum: { quantity: true },
      }),
    ]);
    usedSeconds = all._sum.quantity ?? 0;
    estimatedCostMicros = all._sum.estimatedCostMicros ?? 0;
    unpricedSeconds = unpriced._sum.quantity ?? 0;
  }

  return summarizeUsage({ entitlements, usedSeconds, live, estimatedCostMicros, unpricedSeconds });
}

export function summarizeUsage(input: {
  entitlements: Entitlements;
  usedSeconds: number;
  live: { count: number; reservedSeconds: number };
  estimatedCostMicros: number;
  unpricedSeconds: number;
}): UsageSummary {
  const { entitlements, usedSeconds, live } = input;
  const capacity = entitlements.includedSeconds + entitlements.overageAllowanceSeconds;
  const overageSeconds = Math.max(0, usedSeconds - entitlements.includedSeconds);
  const rawOverageCharge = entitlements.overageRateMinorPerMinute
    ? Math.ceil((overageSeconds * entitlements.overageRateMinorPerMinute) / 60)
    : 0;
  const kinds = alertKindsFor(usedSeconds, entitlements);

  return {
    entitlements,
    usedSeconds,
    liveSessions: live.count,
    reservedSeconds: live.reservedSeconds,
    remainingSeconds: Math.max(0, capacity - usedSeconds - live.reservedSeconds),
    overageSeconds,
    overageChargeMinor: Math.min(rawOverageCharge, entitlements.overageBudgetMinor),
    estimatedCostMicros: input.estimatedCostMicros,
    unpricedSeconds: input.unpricedSeconds,
    percentUsed:
      entitlements.includedSeconds > 0 ? Math.round((usedSeconds / entitlements.includedSeconds) * 100) : 0,
    warning:
      entitlements.includedSeconds <= 0
        ? "none"
        : kinds.includes("ALLOWANCE_EXHAUSTED")
          ? "exhausted"
          : kinds.includes("THRESHOLD_WARNING")
            ? "approaching"
            : "none",
  };
}
