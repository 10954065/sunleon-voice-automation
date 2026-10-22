import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import { TenantAccessError } from "@/server/auth/tenant";
import { resolveEntitlements } from "@/server/billing/entitlements";
import type { ChargeDetails, PaymentProvider } from "@/server/billing/paystack";
import { grantTestPlan, resetDatabase } from "./helpers";

type Role = "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST";
type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: Role;
  membershipId: string;
};

let mockContext: MockContext;

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => mockContext),
  requireCurrentUser: vi.fn(async () => mockContext.user),
}));

/** Test double at the payment-provider boundary; nothing here proves a live Paystack account works. */
const fakeProvider = {
  initializeCheckout: vi.fn<PaymentProvider["initializeCheckout"]>(async () => ({
    authorizationUrl: "https://checkout.paystack.com/test-access-code",
  })),
  verifyTransaction: vi.fn<PaymentProvider["verifyTransaction"]>(),
  disableSubscription: vi.fn<PaymentProvider["disableSubscription"]>(async () => undefined),
};

vi.mock("@/server/billing/paystack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing/paystack")>()),
  getPaymentProvider: () => fakeProvider,
}));

const { startCheckout, confirmCheckout, cancelSubscription, updateOverageBudget } = await import("@/server/actions/billing");
const { updatePlan, createPlan, assignPlan, setVoiceCostRate } = await import("@/server/actions/admin");
const { createAgent, archiveAgent } = await import("@/server/actions/agent");

const SECRET = "sk_test_actions";
const PLAN_CODE = "PLN_actionsstarter";
const originalSecret = process.env.PAYSTACK_SECRET_KEY;
const originalAppUrl = process.env.NEXTAUTH_URL;

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function seed(role: Role = "OWNER", slug = "kofi") {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug } });
  const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}@${slug}.example`, name: role, passwordHash: "x" } });
  const membership = await prisma.membership.create({ data: { userId: user.id, organizationId: organization.id, role } });
  mockContext = { user, organization, role, membershipId: membership.id };
  return { organization, user };
}

async function linkStarterToPaystack() {
  return prisma.plan.update({ where: { code: "starter" }, data: { paystackPlanCode: PLAN_CODE } });
}

describe("billing actions", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    process.env.NEXTAUTH_URL = "http://localhost:3000";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
    if (originalAppUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalAppUrl;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("startCheckout", () => {
    it("is BLOCKED, not faked, when Paystack isn't configured", async () => {
      await seed();
      await linkStarterToPaystack();
      delete process.env.PAYSTACK_SECRET_KEY;

      const result = await startCheckout("kofi", "starter");
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? "" : result.error).toContain("PAYSTACK_SECRET_KEY");
      expect(fakeProvider.initializeCheckout).not.toHaveBeenCalled();
      expect(await prisma.billingTransaction.count()).toBe(0);
    });

    it("is limited to owners and admins", async () => {
      await linkStarterToPaystack();
      for (const role of ["ANALYST", "AGENT_MANAGER"] as const) {
        await resetDatabase();
        await linkStarterToPaystack();
        await seed(role);
        await expect(startCheckout("kofi", "starter")).rejects.toBeInstanceOf(TenantAccessError);
      }
    });

    it("charges the plan's own price under a server-generated reference", async () => {
      const { organization, user } = await seed("ADMIN");
      const plan = await linkStarterToPaystack();

      const result = await startCheckout("kofi", "starter");
      expect(result).toEqual({ ok: true, redirectUrl: "https://checkout.paystack.com/test-access-code" });

      const transaction = await prisma.billingTransaction.findFirstOrThrow({ where: { organizationId: organization.id } });
      expect(transaction).toMatchObject({ status: "PENDING", amountMinor: 29900, currency: "GHS", planId: plan.id, kind: "INITIAL" });
      expect(transaction.reference).toMatch(/^slv_[0-9a-f-]{36}$/);
      expect(fakeProvider.initializeCheckout).toHaveBeenCalledWith({
        email: user.email,
        amountMinor: 29900,
        currency: "GHS",
        planCode: PLAN_CODE,
        reference: transaction.reference,
        callbackUrl: "http://localhost:3000/dashboard/kofi/billing",
      });
    });

    it("refuses trial, private, unlinked and unknown plans", async () => {
      await seed();
      expect(await startCheckout("kofi", "starter")).toMatchObject({ ok: false, error: expect.stringContaining("isn't connected") });
      expect(await startCheckout("kofi", "trial")).toMatchObject({ ok: false, error: "That plan isn't available." });
      expect(await startCheckout("kofi", "no-such-plan")).toMatchObject({ ok: false });
      expect(await startCheckout("kofi", "../../x")).toMatchObject({ ok: false, error: "Unknown plan." });
    });

    it("marks the transaction failed when Paystack refuses the checkout", async () => {
      const { PaymentProviderError } = await import("@/server/billing/paystack");
      await seed();
      await linkStarterToPaystack();
      fakeProvider.initializeCheckout.mockRejectedValueOnce(new PaymentProviderError("Paystack request failed (400: Invalid plan)."));

      const result = await startCheckout("kofi", "starter");
      expect(result).toMatchObject({ ok: false });
      expect((await prisma.billingTransaction.findFirstOrThrow()).status).toBe("FAILED");
    });

    it("won't start a second subscription while one is still renewing", async () => {
      const { organization } = await seed();
      await linkStarterToPaystack();
      await grantTestPlan(organization.id);
      expect(await startCheckout("kofi", "starter")).toMatchObject({ ok: false, error: expect.stringContaining("Cancel it first") });
    });
  });

  describe("confirmCheckout", () => {
    function charge(reference: string, overrides: Partial<ChargeDetails> = {}): ChargeDetails {
      return {
        reference,
        status: "success",
        amountMinor: 29900,
        currency: "GHS",
        paidAt: new Date(),
        customerCode: "CUS_1",
        customerEmail: "owner@kofi.example",
        planCode: PLAN_CODE,
        ...overrides,
      };
    }

    it("activates the plan when Paystack confirms, idempotently", async () => {
      const { organization } = await seed();
      await linkStarterToPaystack();
      await startCheckout("kofi", "starter");
      const { reference } = await prisma.billingTransaction.findFirstOrThrow();
      fakeProvider.verifyTransaction.mockResolvedValue(charge(reference));

      expect(await confirmCheckout("kofi", reference)).toMatchObject({ ok: true });
      expect(await confirmCheckout("kofi", reference)).toMatchObject({ ok: true });
      expect((await resolveEntitlements(prisma, organization.id, new Date())).plan?.code).toBe("starter");
      expect(await prisma.auditLog.count({ where: { action: "billing.subscription_activated" } })).toBe(1);
    });

    it("never confirms another organization's payment", async () => {
      await seed("OWNER", "ama");
      await linkStarterToPaystack();
      await startCheckout("ama", "starter");
      const { reference } = await prisma.billingTransaction.findFirstOrThrow();

      await seed("OWNER", "kofi");
      expect(await confirmCheckout("kofi", reference)).toEqual({ ok: false, error: "Payment not found for this organization." });
      expect(fakeProvider.verifyTransaction).not.toHaveBeenCalled();
    });

    it("marks an abandoned payment failed", async () => {
      await seed();
      await linkStarterToPaystack();
      await startCheckout("kofi", "starter");
      const { reference } = await prisma.billingTransaction.findFirstOrThrow();
      fakeProvider.verifyTransaction.mockResolvedValue(charge(reference, { status: "abandoned" }));

      expect(await confirmCheckout("kofi", reference)).toMatchObject({ ok: false });
      expect((await prisma.billingTransaction.findUniqueOrThrow({ where: { reference } })).status).toBe("FAILED");
    });
  });

  describe("cancelSubscription", () => {
    async function paystackSubscription(organizationId: string, codes: boolean) {
      const plan = await linkStarterToPaystack();
      const now = new Date();
      return prisma.subscription.create({
        data: {
          organizationId,
          planId: plan.id,
          status: "ACTIVE",
          provider: "PAYSTACK",
          billingAnchorAt: now,
          paidThroughAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
          providerCustomerCode: "CUS_1",
          providerSubscriptionCode: codes ? "SUB_1" : null,
          providerEmailToken: codes ? "tok_1" : null,
        },
      });
    }

    it("is owner-only", async () => {
      await seed("ADMIN");
      await expect(cancelSubscription("kofi")).rejects.toBeInstanceOf(TenantAccessError);
    });

    it("disables the Paystack subscription and keeps access to the end of the paid period", async () => {
      const { organization } = await seed();
      await paystackSubscription(organization.id, true);

      expect(await cancelSubscription("kofi")).toMatchObject({ ok: true });
      expect(fakeProvider.disableSubscription).toHaveBeenCalledWith({ subscriptionCode: "SUB_1", emailToken: "tok_1" });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } })).status).toBe("CANCELED");
      expect((await resolveEntitlements(prisma, organization.id, new Date())).source).toBe("subscription");
      expect(await cancelSubscription("kofi")).toMatchObject({ ok: false });
    });

    it("waits for Paystack's subscription codes before cancelling", async () => {
      const { organization } = await seed();
      await paystackSubscription(organization.id, false);
      expect(await cancelSubscription("kofi")).toMatchObject({ ok: false, error: expect.stringContaining("hasn't confirmed") });
      expect(fakeProvider.disableSubscription).not.toHaveBeenCalled();
    });
  });

  describe("updateOverageBudget", () => {
    it("lets only the owner set a validated budget, and audits it", async () => {
      const { organization } = await seed();
      expect(await updateOverageBudget("kofi", form({ budget: "150.50" }))).toMatchObject({ ok: true });
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).overageBudgetMinor).toBe(15050);
      expect(await prisma.auditLog.count({ where: { action: "billing.overage_budget_updated" } })).toBe(1);
      expect(await updateOverageBudget("kofi", form({ budget: "-1" }))).toMatchObject({ ok: false });

      await resetDatabase();
      await seed("ADMIN");
      await expect(updateOverageBudget("kofi", form({ budget: "10" }))).rejects.toBeInstanceOf(TenantAccessError);
    });
  });

  describe("agent limit", () => {
    it("enforces the plan's agent limit, counting only active agents", async () => {
      await seed();
      // Trial plan: one agent.
      const first = await createAgent("kofi", form({ name: "Front desk" }));
      expect(first).toMatchObject({ ok: true });
      expect(await createAgent("kofi", form({ name: "Second" }))).toMatchObject({
        ok: false,
        error: expect.stringContaining("agent limit"),
      });

      await archiveAgent("kofi", first.ok ? (first.agentId as string) : "");
      expect(await createAgent("kofi", form({ name: "Replacement" }))).toMatchObject({ ok: true });
    });

    it("blocks new agents when the organization has no plan", async () => {
      const { organization } = await seed();
      await prisma.organization.update({
        where: { id: organization.id },
        data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });
      expect(await createAgent("kofi", form({ name: "Front desk" }))).toMatchObject({ ok: false });
    });
  });
});

describe("platform admin actions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  async function asAdmin(isPlatformAdmin: boolean) {
    const { user } = await seed("OWNER");
    await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin } });
    return user;
  }

  const planForm = {
    name: "Starter",
    price: "349",
    includedMinutes: "200",
    maxConcurrentSessions: "3",
    maxAgents: "4",
    overageRate: "2.50",
    warningThresholdPercent: "75",
    paystackPlanCode: "PLN_newcode",
    isPublic: "on",
    active: "on",
  };

  it("refuses everyone without the platform-admin flag, including organization owners", async () => {
    await asAdmin(false);
    const starter = await prisma.plan.findUniqueOrThrow({ where: { code: "starter" } });
    await expect(updatePlan(starter.id, form(planForm))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(setVoiceCostRate(form({ ghsPerMinute: "3", note: "x y z" }))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(assignPlan(form({ organizationId: "x", planId: starter.id, months: "1" }))).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("updates a plan with audit, and keeps trial plans private and unlinked", async () => {
    await asAdmin(true);
    const starter = await prisma.plan.findUniqueOrThrow({ where: { code: "starter" } });
    expect(await updatePlan(starter.id, form(planForm))).toMatchObject({ ok: true });
    expect(await prisma.plan.findUniqueOrThrow({ where: { id: starter.id } })).toMatchObject({
      priceMinor: 34900,
      includedMinutes: 200,
      overageRateMinorPerMinute: 250,
      paystackPlanCode: "PLN_newcode",
    });
    expect(await prisma.auditLog.count({ where: { action: "admin.plan_updated" } })).toBe(1);

    const trial = await prisma.plan.findUniqueOrThrow({ where: { code: "trial" } });
    await updatePlan(trial.id, form({ ...planForm, name: "Trial", paystackPlanCode: "PLN_trialsneak", price: "0" }));
    expect(await prisma.plan.findUniqueOrThrow({ where: { id: trial.id } })).toMatchObject({ isPublic: false, paystackPlanCode: null });

    const growth = await prisma.plan.findUniqueOrThrow({ where: { code: "growth" } });
    expect(await updatePlan(growth.id, form(planForm))).toMatchObject({ ok: false, error: expect.stringContaining("already linked") });
  });

  it("creates custom plans and rejects duplicate codes", async () => {
    await asAdmin(true);
    const custom = { ...planForm, code: "enterprise-acme", paystackPlanCode: "", isPublic: "" };
    expect(await createPlan(form(custom))).toMatchObject({ ok: true });
    expect(await prisma.plan.findUniqueOrThrow({ where: { code: "enterprise-acme" } })).toMatchObject({ isPublic: false });
    expect(await createPlan(form(custom))).toMatchObject({ ok: false });
  });

  it("assigns a manual plan, but never over a renewing Paystack subscription", async () => {
    await asAdmin(true);
    const target = await prisma.organization.create({ data: { name: "Ama Clinic", slug: "ama" } });
    const growth = await prisma.plan.findUniqueOrThrow({ where: { code: "growth" } });

    expect(await assignPlan(form({ organizationId: target.id, planId: growth.id, months: "3" }))).toMatchObject({ ok: true });
    const entitlements = await resolveEntitlements(prisma, target.id, new Date());
    expect(entitlements).toMatchObject({ source: "subscription", maxAgents: 10 });
    expect(entitlements.plan?.code).toBe("growth");

    await prisma.subscription.update({ where: { organizationId: target.id }, data: { provider: "PAYSTACK" } });
    expect(await assignPlan(form({ organizationId: target.id, planId: growth.id, months: "1" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Paystack"),
    });
    const trial = await prisma.plan.findUniqueOrThrow({ where: { code: "trial" } });
    expect(await assignPlan(form({ organizationId: target.id, planId: trial.id, months: "1" }))).toMatchObject({ ok: false });
  });

  it("stores the voice cost rate per second with its source, audited", async () => {
    await asAdmin(true);
    expect(await setVoiceCostRate(form({ ghsPerMinute: "3", note: "Gateway invoice, Oct 2026" }))).toMatchObject({ ok: true });
    expect(await prisma.providerCostRate.findFirstOrThrow()).toMatchObject({ microsPerUnit: 50_000, note: "Gateway invoice, Oct 2026" });
    expect(await setVoiceCostRate(form({ ghsPerMinute: "3", note: "" }))).toMatchObject({ ok: false });
    expect(await prisma.auditLog.count({ where: { action: "admin.cost_rate_updated" } })).toBe(1);
  });
});
