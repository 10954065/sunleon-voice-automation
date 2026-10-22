import { z } from "zod";

import { parseMajorToMinor } from "@/lib/billing";

/** GHS 50,000 — a sanity ceiling on what an owner can pre-approve in overage per period. */
const MAX_OVERAGE_BUDGET_MINOR = 5_000_000;
/** GHS 1,000,000 — ceiling for a configured plan price. */
const MAX_PLAN_PRICE_MINOR = 100_000_000;
/** GHS 100 per minute — ceiling for overage and provider cost rates. */
const MAX_RATE_MINOR_PER_MINUTE = 10_000;

function majorAmount(label: string, max: number) {
  return z
    .string()
    .trim()
    .transform((value, ctx) => {
      const minor = parseMajorToMinor(value);
      if (minor === null) {
        ctx.addIssue({ code: "custom", message: `${label} must be an amount like 299 or 299.50.` });
        return z.NEVER;
      }
      if (minor > max) {
        ctx.addIssue({ code: "custom", message: `${label} is too large.` });
        return z.NEVER;
      }
      return minor;
    });
}

/** HTML checkboxes send "on" when ticked and nothing when not; anything else counts as unticked. */
const checkbox = z.unknown().transform((value) => value === "on" || value === "true");

export const planCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "Plan codes use lowercase letters, digits and dashes.");

export const checkoutReferenceSchema = z.string().regex(/^slv_[0-9a-f-]{36}$/, "Invalid payment reference.");

export const overageBudgetSchema = z.object({
  budget: majorAmount("Overage budget", MAX_OVERAGE_BUDGET_MINOR),
});

const paystackPlanCodeSchema = z
  .string()
  .trim()
  .transform((value) => value || null)
  .pipe(z.string().regex(/^PLN_[A-Za-z0-9]+$/, "Paystack plan codes look like PLN_xxxxxxxx.").nullable());

const overageRateSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (!value) {
      return null;
    }
    const minor = parseMajorToMinor(value);
    if (minor === null || minor <= 0 || minor > MAX_RATE_MINOR_PER_MINUTE) {
      ctx.addIssue({ code: "custom", message: "Overage rate must be a per-minute amount between 0.01 and 100." });
      return z.NEVER;
    }
    return minor;
  });

export const planSettingsSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  price: majorAmount("Price", MAX_PLAN_PRICE_MINOR),
  includedMinutes: z.coerce.number().int().min(0).max(100_000),
  maxConcurrentSessions: z.coerce.number().int().min(0).max(100),
  maxAgents: z.coerce.number().int().min(0).max(1_000),
  overageRate: overageRateSchema,
  warningThresholdPercent: z.coerce.number().int().min(1).max(100),
  paystackPlanCode: paystackPlanCodeSchema,
  isPublic: checkbox,
  active: checkbox,
});

export const createPlanSchema = planSettingsSchema.extend({ code: planCodeSchema });

/** Admin enters GHS per minute (up to 4 decimals); stored as micro-GHS per second. */
export const costRateSchema = z.object({
  ghsPerMinute: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!/^\d+(\.\d{1,4})?$/.test(value) || Number(value) <= 0 || Number(value) > 100) {
        ctx.addIssue({ code: "custom", message: "Enter a cost per minute between 0.0001 and 100." });
        return z.NEVER;
      }
      return Math.round((Number(value) * 1_000_000) / 60);
    }),
  note: z.string().trim().min(3, "Say where this number came from.").max(200),
});

export const assignPlanSchema = z.object({
  organizationId: z.string().trim().min(1).max(64),
  planId: z.string().trim().min(1).max(64),
  months: z.coerce.number().int().min(1).max(24),
});
