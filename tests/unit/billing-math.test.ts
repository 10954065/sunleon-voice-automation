import { describe, expect, it } from "vitest";

import {
  addMonthsUtc,
  billingWindow,
  formatMinutes,
  formatMoney,
  minorToMajorString,
  monthsElapsed,
  parseMajorToMinor,
} from "@/lib/billing";
import { computeEntitlements, overageAllowanceSeconds } from "@/server/billing/entitlements";
import { alertKindsFor, isLiveConversation, summarizeUsage } from "@/server/billing/usage";
import type { Plan, Subscription } from "@/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan_x",
    code: "x",
    name: "X",
    priceMinor: 29900,
    currency: "GHS",
    includedMinutes: 150,
    maxConcurrentSessions: 2,
    maxAgents: 3,
    overageRateMinorPerMinute: null,
    warningThresholdPercent: 80,
    isTrial: false,
    trialDays: null,
    isPublic: true,
    active: true,
    paystackPlanCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function subscription(overrides: Partial<Subscription> = {}, planOverrides: Partial<Plan> = {}) {
  return {
    id: "sub",
    organizationId: "org",
    planId: "plan_x",
    status: "ACTIVE" as const,
    provider: "PAYSTACK" as const,
    billingAnchorAt: utc("2026-01-31"),
    paidThroughAt: utc("2026-02-28"),
    providerCustomerCode: null,
    providerSubscriptionCode: null,
    providerEmailToken: null,
    canceledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
    plan: plan(planOverrides),
  };
}

const trialPlan = plan({ id: "plan_trial", code: "trial", includedMinutes: 10, maxConcurrentSessions: 1, maxAgents: 1, isTrial: true, trialDays: 14, priceMinor: 0 });

describe("money and time helpers", () => {
  it("parses major-unit amounts into minor units and rejects anything ambiguous", () => {
    expect(parseMajorToMinor("299")).toBe(29900);
    expect(parseMajorToMinor("299.5")).toBe(29950);
    expect(parseMajorToMinor("1,299.05")).toBe(129905);
    expect(parseMajorToMinor("0")).toBe(0);
    for (const bad of ["", "-1", "1.234", "abc", "1e3", "12.", " . "]) {
      expect(parseMajorToMinor(bad)).toBeNull();
    }
  });

  it("formats money, minutes and round-trips minor units", () => {
    expect(formatMoney(29900, "GHS")).toBe("GHS 299.00");
    expect(minorToMajorString(5)).toBe("0.05");
    expect(formatMinutes(90)).toBe("1.5 min");
  });

  it("adds calendar months in UTC, clamping to shorter months", () => {
    expect(addMonthsUtc(utc("2026-01-31"), 1)).toEqual(utc("2026-02-28"));
    expect(addMonthsUtc(utc("2028-01-31"), 1)).toEqual(utc("2028-02-29"));
    expect(addMonthsUtc(utc("2026-01-31"), 2)).toEqual(utc("2026-03-31"));
    expect(addMonthsUtc(utc("2026-11-15"), 3)).toEqual(utc("2027-02-15"));
  });

  it("finds the monthly window containing a date, counted from the anchor", () => {
    const anchor = utc("2026-01-31");
    expect(monthsElapsed(anchor, utc("2026-02-27"))).toBe(0);
    expect(monthsElapsed(anchor, utc("2026-02-28"))).toBe(1);
    expect(monthsElapsed(anchor, utc("2026-03-30"))).toBe(1);
    expect(monthsElapsed(anchor, utc("2026-03-31"))).toBe(2);
    expect(monthsElapsed(anchor, utc("2025-12-01"))).toBe(0);
    expect(billingWindow(anchor, utc("2026-03-15"))).toEqual({ start: utc("2026-02-28"), end: utc("2026-03-31") });
  });
});

describe("computeEntitlements", () => {
  const organization = { createdAt: utc("2026-01-01"), overageBudgetMinor: 0 };

  it("uses the subscription's plan only while now is before the paid-through date", () => {
    const sub = subscription();
    const during = computeEntitlements({ subscription: sub, trialPlan, organization, now: utc("2026-02-10") });
    expect(during).toMatchObject({ source: "subscription", includedSeconds: 150 * 60, maxConcurrentSessions: 2, maxAgents: 3 });
    expect(during.periodStart).toEqual(utc("2026-01-31"));
    expect(during.periodEnd).toEqual(utc("2026-02-28"));

    const lapsed = computeEntitlements({ subscription: sub, trialPlan, organization, now: utc("2026-03-01") });
    expect(lapsed).toMatchObject({ source: "none", includedSeconds: 0, maxConcurrentSessions: 0, maxAgents: 0 });
    expect(lapsed.subscriptionStatus).toBe("ACTIVE");
  });

  it("keeps a cancelled or past-due subscription entitled until the end of the paid period", () => {
    for (const status of ["CANCELED", "PAST_DUE", "NON_RENEWING"] as const) {
      const result = computeEntitlements({
        subscription: subscription({ status }),
        trialPlan,
        organization,
        now: utc("2026-02-20"),
      });
      expect(result.source).toBe("subscription");
    }
  });

  it("moves to the next monthly window after an on-time renewal extends the paid-through date", () => {
    const renewed = subscription({ paidThroughAt: utc("2026-03-31") });
    const result = computeEntitlements({ subscription: renewed, trialPlan, organization, now: utc("2026-03-05") });
    expect(result.periodStart).toEqual(utc("2026-02-28"));
    expect(result.periodEnd).toEqual(utc("2026-03-31"));
  });

  it("falls back to the trial for trialDays after creation, then to nothing", () => {
    const newOrg = { createdAt: utc("2026-05-01"), overageBudgetMinor: 100_000 };
    const inTrial = computeEntitlements({ subscription: null, trialPlan, organization: newOrg, now: utc("2026-05-10") });
    expect(inTrial).toMatchObject({ source: "trial", includedSeconds: 600, overageAllowanceSeconds: 0 });
    expect(inTrial.periodEnd).toEqual(new Date(utc("2026-05-01").getTime() + 14 * DAY_MS));

    const after = computeEntitlements({ subscription: null, trialPlan, organization: newOrg, now: utc("2026-05-16") });
    expect(after.source).toBe("none");

    const inactiveTrial = computeEntitlements({
      subscription: null,
      trialPlan: { ...trialPlan, active: false },
      organization: newOrg,
      now: utc("2026-05-10"),
    });
    expect(inactiveTrial.source).toBe("none");
  });

  it("never falls back to the trial once the organization has had a subscription", () => {
    const youngOrg = { createdAt: utc("2026-02-20"), overageBudgetMinor: 0 };
    const lapsed = computeEntitlements({
      subscription: subscription({ billingAnchorAt: utc("2026-02-20"), paidThroughAt: utc("2026-02-25") }),
      trialPlan,
      organization: youngOrg,
      now: utc("2026-02-27"),
    });
    expect(lapsed.source).toBe("none");
  });

  it("turns the overage budget into allowance seconds only when the plan has an overage rate", () => {
    expect(overageAllowanceSeconds(10_000, 250)).toBe(2400);
    expect(overageAllowanceSeconds(10_000, null)).toBe(0);
    expect(overageAllowanceSeconds(0, 250)).toBe(0);
    expect(overageAllowanceSeconds(99, 250)).toBe(23);

    const withRate = computeEntitlements({
      subscription: subscription({}, { overageRateMinorPerMinute: 250 }),
      trialPlan,
      organization: { ...organization, overageBudgetMinor: 10_000 },
      now: utc("2026-02-10"),
    });
    expect(withRate.overageAllowanceSeconds).toBe(2400);
  });
});

describe("usage summaries and alerts", () => {
  const base = computeEntitlements({
    subscription: subscription({}, { includedMinutes: 10, overageRateMinorPerMinute: 300 }),
    trialPlan,
    organization: { createdAt: utc("2026-01-01"), overageBudgetMinor: 1500 },
    now: utc("2026-02-10"),
  });

  it("warns at the threshold and again when the included minutes are used up", () => {
    expect(alertKindsFor(479, base)).toEqual([]);
    expect(alertKindsFor(480, base)).toEqual(["THRESHOLD_WARNING"]);
    expect(alertKindsFor(600, base)).toEqual(["THRESHOLD_WARNING", "ALLOWANCE_EXHAUSTED"]);
  });

  it("caps the overage charge at the approved budget and never reports negative remaining time", () => {
    const summary = summarizeUsage({
      entitlements: base,
      usedSeconds: 600 + 10 * 60,
      live: { count: 1, reservedSeconds: 300 },
      estimatedCostMicros: 0,
      unpricedSeconds: 0,
    });
    // 10 overage minutes at GHS 3.00 = GHS 30, but the budget is GHS 15.
    expect(summary.overageSeconds).toBe(600);
    expect(summary.overageChargeMinor).toBe(1500);
    expect(summary.remainingSeconds).toBe(0);
    expect(summary.warning).toBe("exhausted");
  });
});

describe("isLiveConversation", () => {
  const now = new Date("2026-02-10T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it("holds an unstarted session for two minutes and a started one for its reservation plus grace", () => {
    expect(isLiveConversation({ status: "ACTIVE", startedAt: ago(60), tokenIssuedAt: null, reservedSeconds: 600 }, now)).toBe(true);
    expect(isLiveConversation({ status: "ACTIVE", startedAt: ago(121), tokenIssuedAt: null, reservedSeconds: 600 }, now)).toBe(false);
    expect(isLiveConversation({ status: "ACTIVE", startedAt: ago(700), tokenIssuedAt: ago(700), reservedSeconds: 600 }, now)).toBe(true);
    expect(isLiveConversation({ status: "ACTIVE", startedAt: ago(800), tokenIssuedAt: ago(721), reservedSeconds: 600 }, now)).toBe(false);
    expect(isLiveConversation({ status: "COMPLETED", startedAt: ago(1), tokenIssuedAt: ago(1), reservedSeconds: 600 }, now)).toBe(false);
  });
});
