import { prisma } from "@/server/db/client";

/** The plans seeded by the phase4_billing migration, with their migrated values. */
const SEEDED_PLANS = [
  { id: "plan_trial", priceMinor: 0, includedMinutes: 10, maxConcurrentSessions: 1, maxAgents: 1, isTrial: true, trialDays: 14, isPublic: false },
  { id: "plan_starter", priceMinor: 29900, includedMinutes: 150, maxConcurrentSessions: 2, maxAgents: 3, isTrial: false, trialDays: null, isPublic: true },
  { id: "plan_growth", priceMinor: 79900, includedMinutes: 500, maxConcurrentSessions: 5, maxAgents: 10, isTrial: false, trialDays: null, isPublic: true },
];

export async function resetDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  // Cascades to agents, conversations, subscriptions, usage ledger, alerts and transactions.
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.providerCostRate.deleteMany();
  await prisma.errorReport.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.plan.deleteMany({ where: { id: { notIn: SEEDED_PLANS.map((plan) => plan.id) } } });
  for (const { id, ...values } of SEEDED_PLANS) {
    await prisma.plan.update({
      where: { id },
      data: { ...values, active: true, overageRateMinorPerMinute: null, warningThresholdPercent: 80, paystackPlanCode: null },
    });
  }
}

/** Puts an organization on a generous manual plan so tests that aren't about limits aren't blocked by them. */
export async function grantTestPlan(
  organizationId: string,
  overrides: { includedMinutes?: number; maxConcurrentSessions?: number; maxAgents?: number; overageRateMinorPerMinute?: number | null } = {},
  now: Date = new Date()
) {
  const plan = await prisma.plan.create({
    data: {
      code: `test-${organizationId.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Test plan",
      priceMinor: 10000,
      includedMinutes: overrides.includedMinutes ?? 1000,
      maxConcurrentSessions: overrides.maxConcurrentSessions ?? 20,
      maxAgents: overrides.maxAgents ?? 50,
      overageRateMinorPerMinute: overrides.overageRateMinorPerMinute ?? null,
      isPublic: false,
    },
  });
  await prisma.subscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      planId: plan.id,
      status: "ACTIVE",
      provider: "MANUAL",
      billingAnchorAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      paidThroughAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
    },
    update: { planId: plan.id },
  });
  return plan;
}

/**
 * An organization with one agent (version 1, optionally published) on a generous test plan, ready
 * for voice sessions. `storeTranscripts` sets the organization's transcript setting.
 */
export async function seedVoiceOrganization(
  slug: string,
  options: {
    leadCapture?: boolean;
    storeTranscripts?: boolean;
    publish?: boolean;
    agentName?: string;
    /** The plan's billing anchor is a day before this; set it earlier to run sessions in the past. */
    planFrom?: Date;
  } = {}
) {
  const organization = await prisma.organization.create({
    data: { name: `Org ${slug}`, slug, storeTranscripts: options.storeTranscripts ?? false },
  });
  await grantTestPlan(organization.id, {}, options.planFrom);
  const agent = await prisma.agent.create({
    data: { organizationId: organization.id, name: options.agentName ?? `Agent ${slug}`, allowedEmbedDomains: ["shop.example"] },
  });
  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      instructions: `Instructions for ${slug}`,
      leadCaptureEnabled: options.leadCapture ?? true,
      publishedAt: options.publish ? new Date() : null,
    },
  });
  if (options.publish) {
    await prisma.agent.update({ where: { id: agent.id }, data: { publishedVersionId: version.id } });
  }
  return { organization, agent, version };
}

/** Test double at the realtime-provider boundary: proves our lifecycle, not that the live Gateway works. */
export const fakeVoiceProvider = {
  mintToken: async () => ({ token: "vcst_test_double", url: "wss://gateway.invalid/realtime", expiresAt: 4_102_444_800 }),
};
