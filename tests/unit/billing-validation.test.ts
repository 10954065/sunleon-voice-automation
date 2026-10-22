import { describe, expect, it } from "vitest";

import {
  assignPlanSchema,
  checkoutReferenceSchema,
  costRateSchema,
  createPlanSchema,
  overageBudgetSchema,
  planSettingsSchema,
} from "@/lib/validation/billing";

const validPlan = {
  name: "Starter",
  price: "299",
  includedMinutes: "150",
  maxConcurrentSessions: "2",
  maxAgents: "3",
  overageRate: "",
  warningThresholdPercent: "80",
  paystackPlanCode: "",
  isPublic: "on",
  active: null,
};

describe("billing validation", () => {
  it("parses an overage budget in major units and enforces the ceiling", () => {
    expect(overageBudgetSchema.parse({ budget: "150.50" })).toEqual({ budget: 15050 });
    expect(overageBudgetSchema.parse({ budget: "0" })).toEqual({ budget: 0 });
    expect(overageBudgetSchema.safeParse({ budget: "-5" }).success).toBe(false);
    expect(overageBudgetSchema.safeParse({ budget: "50000.01" }).success).toBe(false);
  });

  it("parses plan settings into minor units, nulls and booleans", () => {
    expect(planSettingsSchema.parse(validPlan)).toEqual({
      name: "Starter",
      price: 29900,
      includedMinutes: 150,
      maxConcurrentSessions: 2,
      maxAgents: 3,
      overageRate: null,
      warningThresholdPercent: 80,
      paystackPlanCode: null,
      isPublic: true,
      active: false,
    });
    expect(planSettingsSchema.parse({ ...validPlan, overageRate: "2.50", paystackPlanCode: "PLN_abc123" })).toMatchObject({
      overageRate: 250,
      paystackPlanCode: "PLN_abc123",
    });
  });

  it("rejects unsafe plan settings", () => {
    for (const bad of [
      { price: "abc" },
      { includedMinutes: "-1" },
      { maxConcurrentSessions: "1.5" },
      { overageRate: "0" },
      { overageRate: "101" },
      { warningThresholdPercent: "0" },
      { paystackPlanCode: "starter" },
      { name: "" },
    ]) {
      expect(planSettingsSchema.safeParse({ ...validPlan, ...bad }).success).toBe(false);
    }
    expect(createPlanSchema.safeParse({ ...validPlan, code: "Bad Code!" }).success).toBe(false);
    expect(createPlanSchema.parse({ ...validPlan, code: "Enterprise-Acme" }).code).toBe("enterprise-acme");
  });

  it("converts a GHS-per-minute cost rate to micro-GHS per second and requires a source", () => {
    expect(costRateSchema.parse({ ghsPerMinute: "3", note: "Gateway invoice" }).ghsPerMinute).toBe(50_000);
    expect(costRateSchema.parse({ ghsPerMinute: "0.0006", note: "test" }).ghsPerMinute).toBe(10);
    expect(costRateSchema.safeParse({ ghsPerMinute: "0", note: "x y z" }).success).toBe(false);
    expect(costRateSchema.safeParse({ ghsPerMinute: "3", note: "" }).success).toBe(false);
  });

  it("only accepts our own checkout reference format", () => {
    expect(checkoutReferenceSchema.safeParse("slv_123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
    expect(checkoutReferenceSchema.safeParse("T123456").success).toBe(false);
    expect(checkoutReferenceSchema.safeParse("slv_../../etc").success).toBe(false);
  });

  it("bounds manual plan assignments", () => {
    expect(assignPlanSchema.safeParse({ organizationId: "o", planId: "p", months: "12" }).success).toBe(true);
    expect(assignPlanSchema.safeParse({ organizationId: "o", planId: "p", months: "25" }).success).toBe(false);
    expect(assignPlanSchema.safeParse({ organizationId: "", planId: "p", months: "1" }).success).toBe(false);
  });
});
