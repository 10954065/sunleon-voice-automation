import "server-only";

import { prisma } from "@/server/db/client";
import { addDays, billingWindow } from "@/lib/billing";
import type { Plan, Prisma, Subscription, SubscriptionStatus } from "@/generated/prisma/client";

export type Db = Prisma.TransactionClient | typeof prisma;

export type EntitlementSource = "subscription" | "trial" | "none";

export interface Entitlements {
  source: EntitlementSource;
  plan: Plan | null;
  subscriptionStatus: SubscriptionStatus | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  currency: string;
  includedSeconds: number;
  /** Extra seconds the organization's overage budget buys at the plan's overage rate. */
  overageAllowanceSeconds: number;
  overageRateMinorPerMinute: number | null;
  overageBudgetMinor: number;
  maxConcurrentSessions: number;
  maxAgents: number;
  warningThresholdPercent: number;
}

const DEFAULT_CURRENCY = "GHS";
const DEFAULT_WARNING_PERCENT = 80;

/** Overage time an organization has pre-approved: whole seconds its budget covers at the plan's rate. */
export function overageAllowanceSeconds(budgetMinor: number, rateMinorPerMinute: number | null): number {
  if (!rateMinorPerMinute || rateMinorPerMinute <= 0 || budgetMinor <= 0) {
    return 0;
  }
  return Math.floor((budgetMinor * 60) / rateMinorPerMinute);
}

/**
 * Pure decision: which plan and billing period apply right now.
 * 1. A subscription, but only while now is before its paid-through date — status alone never
 *    grants access, so a missed renewal lapses on its own even if no webhook ever arrives. The
 *    period is the calendar month (counted from the billing anchor) containing now, cut short
 *    at the paid-through date.
 * 2. Otherwise the trial plan, for trialDays after the organization was created — but only for an
 *    organization that has never had a subscription, so a lapsed paid plan doesn't fall back to it.
 * 3. Otherwise nothing: no voice minutes, no new agents.
 */
export function computeEntitlements(input: {
  subscription: (Subscription & { plan: Plan }) | null;
  trialPlan: Plan | null;
  organization: { createdAt: Date; overageBudgetMinor: number };
  now: Date;
}): Entitlements {
  const { subscription, trialPlan, organization, now } = input;

  if (subscription && subscription.billingAnchorAt <= now && now < subscription.paidThroughAt) {
    const window = billingWindow(subscription.billingAnchorAt, now);
    return fromPlan("subscription", subscription.plan, subscription.status, {
      start: window.start,
      end: window.end < subscription.paidThroughAt ? window.end : subscription.paidThroughAt,
      overageBudgetMinor: organization.overageBudgetMinor,
    });
  }

  if (!subscription && trialPlan && trialPlan.active && trialPlan.trialDays) {
    const trialEnd = addDays(organization.createdAt, trialPlan.trialDays);
    if (now < trialEnd) {
      return fromPlan("trial", trialPlan, null, {
        start: organization.createdAt,
        end: trialEnd,
        // Trials never run into overage, whatever the budget says.
        overageBudgetMinor: 0,
      });
    }
  }

  return {
    source: "none",
    plan: null,
    subscriptionStatus: subscription?.status ?? null,
    periodStart: null,
    periodEnd: null,
    currency: DEFAULT_CURRENCY,
    includedSeconds: 0,
    overageAllowanceSeconds: 0,
    overageRateMinorPerMinute: null,
    overageBudgetMinor: organization.overageBudgetMinor,
    maxConcurrentSessions: 0,
    maxAgents: 0,
    warningThresholdPercent: DEFAULT_WARNING_PERCENT,
  };
}

function fromPlan(
  source: EntitlementSource,
  plan: Plan,
  status: SubscriptionStatus | null,
  period: { start: Date; end: Date; overageBudgetMinor: number }
): Entitlements {
  return {
    source,
    plan,
    subscriptionStatus: status,
    periodStart: period.start,
    periodEnd: period.end,
    currency: plan.currency,
    includedSeconds: plan.includedMinutes * 60,
    overageAllowanceSeconds: overageAllowanceSeconds(period.overageBudgetMinor, plan.overageRateMinorPerMinute),
    overageRateMinorPerMinute: plan.overageRateMinorPerMinute,
    overageBudgetMinor: period.overageBudgetMinor,
    maxConcurrentSessions: plan.maxConcurrentSessions,
    maxAgents: plan.maxAgents,
    warningThresholdPercent: plan.warningThresholdPercent,
  };
}

export async function resolveEntitlements(db: Db, organizationId: string, now: Date): Promise<Entitlements> {
  const [organization, subscription, trialPlan] = await Promise.all([
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { createdAt: true, overageBudgetMinor: true },
    }),
    db.subscription.findUnique({ where: { organizationId }, include: { plan: true } }),
    db.plan.findFirst({ where: { isTrial: true, active: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return computeEntitlements({ subscription, trialPlan, organization, now });
}
