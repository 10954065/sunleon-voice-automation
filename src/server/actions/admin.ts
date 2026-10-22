"use server";

import { prisma } from "@/server/db/client";
import { Prisma } from "@/generated/prisma/client";
import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { addMonthsUtc } from "@/lib/billing";
import { REALTIME_VOICE_MODEL } from "@/lib/voice";
import { VOICE_PROVIDER_ID } from "@/server/billing/usage";
import { assignPlanSchema, costRateSchema, createPlanSchema, planSettingsSchema } from "@/lib/validation/billing";

export type AdminActionResult = { ok: true; message?: string } | { ok: false; error: string };

function planFields(formData: FormData) {
  return {
    name: formData.get("name") ?? "",
    price: formData.get("price") ?? "",
    includedMinutes: formData.get("includedMinutes") ?? "",
    maxConcurrentSessions: formData.get("maxConcurrentSessions") ?? "",
    maxAgents: formData.get("maxAgents") ?? "",
    overageRate: formData.get("overageRate") ?? "",
    warningThresholdPercent: formData.get("warningThresholdPercent") ?? "",
    paystackPlanCode: formData.get("paystackPlanCode") ?? "",
    isPublic: formData.get("isPublic"),
    active: formData.get("active"),
  };
}

function toPlanData(data: ReturnType<typeof planSettingsSchema.parse>) {
  return {
    name: data.name,
    priceMinor: data.price,
    includedMinutes: data.includedMinutes,
    maxConcurrentSessions: data.maxConcurrentSessions,
    maxAgents: data.maxAgents,
    overageRateMinorPerMinute: data.overageRate,
    warningThresholdPercent: data.warningThresholdPercent,
    paystackPlanCode: data.paystackPlanCode,
    isPublic: data.isPublic,
    active: data.active,
  };
}

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Plan changes apply to every organization on the plan from their next check, so they're audit-logged. */
export async function updatePlan(planId: string, formData: FormData): Promise<AdminActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = planSettingsSchema.safeParse(planFields(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid plan settings." };
  }
  const existing = await prisma.plan.findUnique({ where: { id: planId } });
  if (!existing) {
    return { ok: false, error: "Plan not found." };
  }
  // Trial plans are never sold, so they can't be public or linked to Paystack.
  const data = existing.isTrial
    ? { ...toPlanData(parsed.data), isPublic: false, paystackPlanCode: null }
    : toPlanData(parsed.data);

  try {
    await prisma.$transaction([
      prisma.plan.update({ where: { id: planId }, data }),
      prisma.auditLog.create({
        data: { actorUserId: admin.id, action: "admin.plan_updated", metadata: { planId, code: existing.code, ...data } },
      }),
    ]);
  } catch (error) {
    if (uniqueViolation(error)) {
      return { ok: false, error: "That Paystack plan code is already linked to another plan." };
    }
    throw error;
  }
  return { ok: true, message: "Plan saved." };
}

/** Custom (e.g. enterprise) plans default to private and are assigned to organizations by an admin. */
export async function createPlan(formData: FormData): Promise<AdminActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = createPlanSchema.safeParse({ ...planFields(formData), code: formData.get("code") ?? "" });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid plan settings." };
  }
  try {
    const plan = await prisma.plan.create({ data: { code: parsed.data.code, ...toPlanData(parsed.data) } });
    await prisma.auditLog.create({
      data: { actorUserId: admin.id, action: "admin.plan_created", metadata: { planId: plan.id, code: plan.code } },
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      return { ok: false, error: "A plan with that code or Paystack plan code already exists." };
    }
    throw error;
  }
  return { ok: true, message: "Plan created." };
}

/**
 * Puts an organization on a plan without Paystack (enterprise contracts, pilots, or while
 * payments are BLOCKED). Refused while a Paystack subscription is still renewing, so a
 * customer is never billed twice for overlapping plans.
 */
export async function assignPlan(formData: FormData): Promise<AdminActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = assignPlanSchema.safeParse({
    organizationId: formData.get("organizationId") ?? "",
    planId: formData.get("planId") ?? "",
    months: formData.get("months") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid assignment." };
  }

  const [organization, plan, current] = await Promise.all([
    prisma.organization.findUnique({ where: { id: parsed.data.organizationId } }),
    prisma.plan.findFirst({ where: { id: parsed.data.planId, active: true, isTrial: false } }),
    prisma.subscription.findUnique({ where: { organizationId: parsed.data.organizationId } }),
  ]);
  if (!organization || !plan) {
    return { ok: false, error: "Organization or plan not found." };
  }
  const now = new Date();
  if (
    current?.provider === "PAYSTACK" &&
    (current.status === "ACTIVE" || current.status === "PAST_DUE") &&
    current.paidThroughAt > now
  ) {
    return { ok: false, error: "This organization has a renewing Paystack subscription. It must be cancelled first." };
  }

  const subscriptionData = {
    planId: plan.id,
    status: "ACTIVE" as const,
    provider: "MANUAL" as const,
    billingAnchorAt: now,
    paidThroughAt: addMonthsUtc(now, parsed.data.months),
    providerCustomerCode: null,
    providerSubscriptionCode: null,
    providerEmailToken: null,
    canceledAt: null,
  };
  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { organizationId: organization.id },
      create: { organizationId: organization.id, ...subscriptionData },
      update: subscriptionData,
    }),
    prisma.auditLog.create({
      data: {
        organizationId: organization.id,
        actorUserId: admin.id,
        action: "admin.plan_assigned",
        metadata: { planCode: plan.code, months: parsed.data.months },
      },
    }),
  ]);
  return { ok: true, message: `${organization.name} is on ${plan.name} for ${parsed.data.months} month(s).` };
}

/** The realtime voice cost estimate. Applies to usage recorded from now on; past rows keep their snapshot. */
export async function setVoiceCostRate(formData: FormData): Promise<AdminActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = costRateSchema.safeParse({
    ghsPerMinute: formData.get("ghsPerMinute") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid cost rate." };
  }

  const key = { metric: "VOICE_SECONDS" as const, provider: VOICE_PROVIDER_ID, model: REALTIME_VOICE_MODEL };
  await prisma.$transaction([
    prisma.providerCostRate.upsert({
      where: { metric_provider_model: key },
      create: { ...key, microsPerUnit: parsed.data.ghsPerMinute, note: parsed.data.note, updatedByUserId: admin.id },
      update: { microsPerUnit: parsed.data.ghsPerMinute, note: parsed.data.note, updatedByUserId: admin.id },
    }),
    prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: "admin.cost_rate_updated",
        metadata: { ...key, microsPerUnit: parsed.data.ghsPerMinute, note: parsed.data.note },
      },
    }),
  ]);
  return { ok: true, message: "Cost rate saved. It applies to usage recorded from now on." };
}
