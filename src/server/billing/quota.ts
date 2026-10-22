import "server-only";

import { MAX_SESSION_SECONDS, MIN_SESSION_SECONDS } from "@/lib/voice";
import { resolveEntitlements } from "./entitlements";
import { getLiveSessions, getPeriodUsageSeconds } from "./usage";
import { sweepOrganization } from "./sweeper";
import type { Prisma } from "@/generated/prisma/client";

/** First key of the two-key advisory lock, so these locks can't collide with Prisma's migration lock. */
const QUOTA_LOCK_NAMESPACE = 4_240_001;

export type QuotaRefusal = "no_plan" | "allowance_exhausted" | "concurrency_limit";

/** Shown to the organization's own dashboard users. Public visitors get a generic message instead. */
const QUOTA_MESSAGES: Record<QuotaRefusal, string> = {
  no_plan: "Your organization has no active plan. Choose a plan on the Billing page to use voice.",
  allowance_exhausted:
    "Your plan's voice minutes for this billing period are used up. Raise the overage budget or change plan on the Billing page.",
  concurrency_limit:
    "Your plan's limit on simultaneous voice sessions is reached. Try again when a current session ends.",
};

export class QuotaExceededError extends Error {
  readonly reason: QuotaRefusal;
  readonly status: number;

  constructor(reason: QuotaRefusal) {
    super(QUOTA_MESSAGES[reason]);
    this.reason = reason;
    this.status = reason === "concurrency_limit" ? 429 : 402;
  }
}

/** Serialises entitlement-checked writes for one organization until the surrounding transaction ends. */
export async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${QUOTA_LOCK_NAMESPACE}::int, hashtext(${organizationId}))`;
}

/**
 * Decides how many voice seconds a new session may use, and must run inside the transaction
 * that creates the conversation holding that reservation. The per-organization advisory lock
 * serialises concurrent requests, so parallel prepares can't each see the same free allowance
 * or concurrency slot — usage can't run past the plan plus the owner's approved overage budget.
 */
export async function reserveVoiceSeconds(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date
): Promise<number> {
  await lockOrganization(tx, organizationId);

  // Release allowance still held by abandoned sessions before counting.
  await sweepOrganization(tx, organizationId, now);

  const entitlements = await resolveEntitlements(tx, organizationId, now);
  if (entitlements.source === "none" || !entitlements.periodStart || !entitlements.periodEnd) {
    throw new QuotaExceededError("no_plan");
  }

  const live = await getLiveSessions(tx, organizationId, now);
  if (live.count >= entitlements.maxConcurrentSessions) {
    throw new QuotaExceededError("concurrency_limit");
  }

  const used = await getPeriodUsageSeconds(tx, organizationId, entitlements.periodStart, entitlements.periodEnd);
  const remaining =
    entitlements.includedSeconds + entitlements.overageAllowanceSeconds - used - live.reservedSeconds;
  if (remaining < MIN_SESSION_SECONDS) {
    throw new QuotaExceededError("allowance_exhausted");
  }

  return Math.min(MAX_SESSION_SECONDS, remaining);
}
