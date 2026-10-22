import { createHmac, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { handlePaystackWebhook } from "@/server/billing/webhooks";
import { resolveEntitlements } from "@/server/billing/entitlements";
import { parseCharge, PaymentProviderError, type ChargeDetails, type PaymentProvider } from "@/server/billing/paystack";
import { addMonthsUtc } from "@/lib/billing";
import { resetDatabase } from "./helpers";

/**
 * Signed webhook payloads built to Paystack's documented shapes, with the verify-transaction call
 * answered by a test double. Proves our verification, idempotency and lifecycle handling — NOT
 * that a live Paystack account sends exactly these payloads (BLOCKED on credentials).
 */
const SECRET = "sk_test_webhook_secret_for_tests";
const PLAN_CODE = "PLN_teststarter";
const originalSecret = process.env.PAYSTACK_SECRET_KEY;
const originalCronSecret = process.env.CRON_SECRET;

const sign = (body: string) => createHmac("sha512", SECRET).update(body, "utf8").digest("hex");

/** Answers verifyTransaction from what the webhook said, unless a test overrides a reference. */
const verifyOverrides = new Map<string, Partial<ChargeDetails> | Error>();
const lastCharges = new Map<string, ChargeDetails>();
const fakeProvider: PaymentProvider = {
  initializeCheckout: vi.fn(),
  disableSubscription: vi.fn(),
  verifyTransaction: vi.fn(async (reference: string) => {
    const override = verifyOverrides.get(reference);
    if (override instanceof Error) {
      throw override;
    }
    const base = lastCharges.get(reference);
    if (!base) {
      throw new PaymentProviderError("unknown reference");
    }
    return { ...base, ...override };
  }),
};

async function send(event: string, data: Record<string, unknown>, options: { signature?: string | null; now?: Date } = {}) {
  const rawBody = JSON.stringify({ event, data });
  if (event === "charge.success") {
    const charge = parseCharge(data);
    if (charge) lastCharges.set(charge.reference, charge);
  }
  return handlePaystackWebhook({
    rawBody,
    signature: options.signature === undefined ? sign(rawBody) : options.signature,
    provider: fakeProvider,
    now: options.now,
  });
}

function chargeData(reference: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 302961,
    reference,
    status: "success",
    amount: 29900,
    currency: "GHS",
    paid_at: "2026-10-01T10:00:00.000Z",
    customer: { customer_code: "CUS_kofi", email: "owner@kofi.example" },
    plan: { plan_code: PLAN_CODE },
    authorization: { authorization_code: "AUTH_should_never_be_stored", last4: "4081" },
    ...overrides,
  };
}

async function seed(slug = "kofi", email = "owner@kofi.example") {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug } });
  const plan =
    (await prisma.plan.findFirst({ where: { paystackPlanCode: PLAN_CODE } })) ??
    (await prisma.plan.create({
      data: {
        code: "test-starter",
        name: "Test Starter",
        priceMinor: 29900,
        includedMinutes: 150,
        maxConcurrentSessions: 2,
        maxAgents: 3,
        paystackPlanCode: PLAN_CODE,
      },
    }));
  const reference = `slv_${randomUUID()}`;
  await prisma.billingTransaction.create({
    data: {
      organizationId: organization.id,
      planId: plan.id,
      provider: "PAYSTACK",
      kind: "INITIAL",
      reference,
      amountMinor: plan.priceMinor,
      currency: "GHS",
      customerEmail: email,
    },
  });
  return { organization, plan, reference };
}

describe("Paystack webhooks", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    verifyOverrides.clear();
    lastCharges.clear();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("authentication", () => {
    it("refuses to act when no secret is configured (BLOCKED, not mocked success)", async () => {
      const { reference } = await seed();
      delete process.env.PAYSTACK_SECRET_KEY;
      expect(await send("charge.success", chargeData(reference))).toEqual({ status: 503, result: "not_configured" });
      expect(await prisma.paymentWebhookEvent.count()).toBe(0);
    });

    it("rejects a bad or missing signature without touching anything", async () => {
      const { reference } = await seed();
      expect((await send("charge.success", chargeData(reference), { signature: "0".repeat(128) })).status).toBe(401);
      expect((await send("charge.success", chargeData(reference), { signature: null })).status).toBe(401);
      expect(await prisma.paymentWebhookEvent.count()).toBe(0);
      expect((await prisma.billingTransaction.findUniqueOrThrow({ where: { reference } })).status).toBe("PENDING");
      expect(fakeProvider.verifyTransaction).not.toHaveBeenCalledWith(reference);
    });

    it("answers 400 to a signed body that isn't a Paystack event", async () => {
      const rawBody = "not json";
      expect(await handlePaystackWebhook({ rawBody, signature: sign(rawBody), provider: fakeProvider })).toEqual({
        status: 400,
        result: "malformed",
      });
    });
  });

  describe("charge.success for our checkout", () => {
    it("activates the plan for the organization that started the checkout", async () => {
      const { organization, plan, reference } = await seed();
      expect(await send("charge.success", chargeData(reference))).toEqual({ status: 200, result: "processed" });

      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      const paidAt = new Date("2026-10-01T10:00:00.000Z");
      expect(subscription).toMatchObject({
        planId: plan.id,
        status: "ACTIVE",
        provider: "PAYSTACK",
        billingAnchorAt: paidAt,
        paidThroughAt: addMonthsUtc(paidAt, 1),
        providerCustomerCode: "CUS_kofi",
      });
      expect(await prisma.billingTransaction.findUniqueOrThrow({ where: { reference } })).toMatchObject({
        status: "SUCCESS",
        paidAt,
      });
      const event = await prisma.paymentWebhookEvent.findFirstOrThrow();
      expect(event).toMatchObject({ eventType: "charge.success", status: "PROCESSED", organizationId: organization.id });
      expect(JSON.stringify(event.summary)).not.toContain("AUTH_should_never_be_stored");
      expect(await prisma.auditLog.count({ where: { action: "billing.subscription_activated" } })).toBe(1);
    });

    it("treats an identical redelivery as a duplicate and a re-signed variant as a no-op", async () => {
      const { organization, reference } = await seed();
      await send("charge.success", chargeData(reference));
      const before = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });

      expect(await send("charge.success", chargeData(reference))).toEqual({ status: 200, result: "duplicate" });
      // A different body for the same payment (e.g. later field changes) is recorded but grants nothing new.
      await send("charge.success", chargeData(reference, { paid_at: "2026-10-20T10:00:00.000Z" }));

      const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      expect(after.paidThroughAt).toEqual(before.paidThroughAt);
      expect(await prisma.billingTransaction.count({ where: { organizationId: organization.id } })).toBe(1);
      expect(await prisma.paymentWebhookEvent.count()).toBe(2);
    });

    it("processes concurrent deliveries of the same event once", async () => {
      const { organization, reference } = await seed();
      const results = await Promise.all(Array.from({ length: 4 }, () => send("charge.success", chargeData(reference))));
      expect(results.filter((r) => r.result === "processed")).toHaveLength(1);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await prisma.auditLog.count({ where: { organizationId: organization.id, action: "billing.subscription_activated" } })).toBe(1);
    });

    it("grants nothing when Paystack's own API doesn't confirm the payment", async () => {
      const { organization, reference } = await seed();
      verifyOverrides.set(reference, { status: "failed" });
      expect(await send("charge.success", chargeData(reference))).toEqual({ status: 200, result: "ignored" });
      expect(await prisma.subscription.count({ where: { organizationId: organization.id } })).toBe(0);
      expect((await prisma.billingTransaction.findUniqueOrThrow({ where: { reference } })).status).toBe("PENDING");
    });

    it("rejects a payment whose verified amount or currency doesn't match the plan", async () => {
      const { organization, reference } = await seed();
      verifyOverrides.set(reference, { amountMinor: 100 });
      await send("charge.success", chargeData(reference));
      expect(await prisma.subscription.count({ where: { organizationId: organization.id } })).toBe(0);
      expect(await prisma.billingTransaction.findUniqueOrThrow({ where: { reference } })).toMatchObject({
        status: "REJECTED",
        failureReason: "amount 100 != expected 29900",
      });

      const second = await seed("ama", "owner@ama.example");
      verifyOverrides.set(second.reference, { currency: "NGN" });
      await send("charge.success", chargeData(second.reference));
      expect((await prisma.billingTransaction.findUniqueOrThrow({ where: { reference: second.reference } })).status).toBe("REJECTED");
    });

    it("asks Paystack to retry (503) when verification can't reach Paystack, then succeeds on retry", async () => {
      const { organization, reference } = await seed();
      verifyOverrides.set(reference, new PaymentProviderError("timeout"));
      expect(await send("charge.success", chargeData(reference))).toEqual({ status: 503, result: "retry" });
      expect(await prisma.paymentWebhookEvent.count()).toBe(0);

      verifyOverrides.delete(reference);
      expect((await send("charge.success", chargeData(reference))).result).toBe("processed");
      expect(await prisma.subscription.count({ where: { organizationId: organization.id } })).toBe(1);
    });
  });

  describe("subscription lifecycle", () => {
    const subscriptionCreated = (code = "SUB_kofi", customer = "CUS_kofi", email = "owner@kofi.example") => ({
      subscription_code: code,
      email_token: "tok_kofi",
      next_payment_date: "2026-11-01T10:00:00.000Z",
      customer: { customer_code: customer, email },
      plan: { plan_code: PLAN_CODE },
    });

    it("asks for a retry if subscription.create beats charge.success, then stores the codes", async () => {
      const { organization, reference } = await seed();
      expect(await send("subscription.create", subscriptionCreated())).toEqual({ status: 503, result: "retry" });

      await send("charge.success", chargeData(reference));
      expect((await send("subscription.create", subscriptionCreated())).result).toBe("processed");
      expect(await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } })).toMatchObject({
        providerSubscriptionCode: "SUB_kofi",
        providerEmailToken: "tok_kofi",
      });
    });

    it("ignores subscriptions it can't map to one of our checkouts", async () => {
      await seed();
      expect((await send("subscription.create", subscriptionCreated("SUB_x", "CUS_stranger", "x@y.example"))).result).toBe("ignored");
    });

    async function activeSubscription() {
      const seeded = await seed();
      await send("charge.success", chargeData(seeded.reference));
      await send("subscription.create", subscriptionCreated());
      return seeded;
    }

    it("extends an on-time renewal by a month on the same anchor", async () => {
      const { organization } = await activeSubscription();
      const before = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });

      await send("charge.success", chargeData("T_paystack_renewal_1", { paid_at: "2026-11-01T09:00:00.000Z" }));

      const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      expect(after.billingAnchorAt).toEqual(before.billingAnchorAt);
      expect(after.paidThroughAt).toEqual(addMonthsUtc(before.billingAnchorAt, 2));
      expect(await prisma.billingTransaction.findUniqueOrThrow({ where: { reference: "T_paystack_renewal_1" } })).toMatchObject({
        kind: "RENEWAL",
        status: "SUCCESS",
        organizationId: organization.id,
      });
    });

    it("re-anchors a renewal paid after the subscription lapsed", async () => {
      const { organization } = await activeSubscription();
      await send("charge.success", chargeData("T_late", { paid_at: "2026-11-20T09:00:00.000Z" }));
      const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      expect(after.billingAnchorAt).toEqual(new Date("2026-11-20T09:00:00.000Z"));
      expect(after.paidThroughAt).toEqual(new Date("2026-12-20T09:00:00.000Z"));
    });

    it("never applies one customer's renewal to another organization", async () => {
      const { organization } = await activeSubscription();
      const other = await seed("ama", "owner@ama.example");
      await send("charge.success", chargeData(other.reference, { customer: { customer_code: "CUS_ama", email: "owner@ama.example" } }));
      const amaBefore = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: other.organization.id } });

      await send("charge.success", chargeData("T_kofi_renewal", { paid_at: "2026-11-01T09:00:00.000Z" }));

      const amaAfter = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: other.organization.id } });
      expect(amaAfter.paidThroughAt).toEqual(amaBefore.paidThroughAt);
      expect((await prisma.billingTransaction.findUniqueOrThrow({ where: { reference: "T_kofi_renewal" } })).organizationId).toBe(
        organization.id
      );
      expect((await send("charge.success", chargeData("T_unknown", { customer: { customer_code: "CUS_nobody" } }))).result).toBe(
        "ignored"
      );
    });

    it("marks a failed renewal past due but keeps access until the paid period ends", async () => {
      const { organization } = await activeSubscription();
      await send("invoice.payment_failed", { subscription: { subscription_code: "SUB_kofi" } });

      const subscription = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      expect(subscription.status).toBe("PAST_DUE");
      const during = await resolveEntitlements(prisma, organization.id, new Date("2026-10-15T00:00:00.000Z"));
      expect(during.source).toBe("subscription");
      const after = await resolveEntitlements(prisma, organization.id, new Date("2026-11-02T00:00:00.000Z"));
      expect(after.source).toBe("none");
    });

    it("tracks not-renewing and cancellation, and a later failure notice can't revive a cancelled one", async () => {
      const { organization } = await activeSubscription();
      await send("subscription.not_renew", { subscription_code: "SUB_kofi" });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } })).status).toBe("NON_RENEWING");

      await send("subscription.disable", { subscription_code: "SUB_kofi" });
      const cancelled = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } });
      expect(cancelled.status).toBe("CANCELED");
      expect(cancelled.canceledAt).not.toBeNull();

      await send("invoice.payment_failed", { subscription: { subscription_code: "SUB_kofi" } });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: organization.id } })).status).toBe("CANCELED");
    });

    it("records unused event types as ignored", async () => {
      expect(await send("transfer.success", { reference: "x" })).toEqual({ status: 200, result: "ignored" });
      expect(await prisma.paymentWebhookEvent.findFirstOrThrow()).toMatchObject({ status: "IGNORED", eventType: "transfer.success" });
    });
  });

  describe("routes", () => {
    it("maps webhook outcomes to HTTP statuses and rejects oversized bodies", async () => {
      const route = await import("@/app/api/webhooks/paystack/route");
      const rawBody = JSON.stringify({ event: "transfer.success", data: {} });
      const signed = new NextRequest("http://localhost/api/webhooks/paystack", {
        method: "POST",
        body: rawBody,
        headers: { "x-paystack-signature": sign(rawBody) },
      });
      expect((await route.POST(signed)).status).toBe(200);

      const unsigned = new NextRequest("http://localhost/api/webhooks/paystack", { method: "POST", body: rawBody });
      expect((await route.POST(unsigned)).status).toBe(401);

      const huge = new NextRequest("http://localhost/api/webhooks/paystack", { method: "POST", body: "x".repeat(300_000) });
      expect((await route.POST(huge)).status).toBe(413);
    });

    it("protects the cron sweep with CRON_SECRET", async () => {
      const route = await import("@/app/api/cron/sweep-sessions/route");
      const request = (authorization?: string) =>
        new NextRequest("http://localhost/api/cron/sweep-sessions", {
          headers: authorization ? { authorization } : {},
        });

      delete process.env.CRON_SECRET;
      expect((await route.GET(request("Bearer anything"))).status).toBe(503);

      process.env.CRON_SECRET = "cron-secret-for-tests";
      expect((await route.GET(request())).status).toBe(401);
      expect((await route.GET(request("Bearer wrong"))).status).toBe(401);
      const ok = await route.GET(request("Bearer cron-secret-for-tests"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ closed: 0 });
    });
  });
});
