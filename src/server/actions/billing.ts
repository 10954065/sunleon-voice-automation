"use server";

import { randomUUID } from "node:crypto";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { resolveEntitlements } from "@/server/billing/entitlements";
import { applySuccessfulCharge } from "@/server/billing/charges";
import {
  getPaymentProvider,
  isPaymentConfigured,
  MissingPaymentCredentialsError,
  PaymentProviderError,
} from "@/server/billing/paystack";
import { checkoutReferenceSchema, overageBudgetSchema, planCodeSchema } from "@/lib/validation/billing";

export type BillingActionResult =
  | { ok: true; redirectUrl?: string; message?: string }
  | { ok: false; error: string };

const PAYMENTS_BLOCKED_MESSAGE =
  "Online payments aren't switched on yet (PAYSTACK_SECRET_KEY is not configured). Contact Sunleon to be set up on a plan.";

function appUrl(): string | null {
  const url = process.env.NEXTAUTH_URL?.trim().replace(/\/$/, "");
  return url || null;
}

/**
 * Starts a Paystack checkout for a self-serve plan. The amount, currency and plan code all come
 * from our Plan row — the client only names which plan — and the reference is ours, so the
 * webhook can map the payment back to this organization without trusting anything in it.
 */
export async function startCheckout(organizationSlug: string, planCode: string): Promise<BillingActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const code = planCodeSchema.safeParse(planCode);
  if (!code.success) {
    return { ok: false, error: "Unknown plan." };
  }
  if (!isPaymentConfigured()) {
    return { ok: false, error: PAYMENTS_BLOCKED_MESSAGE };
  }
  const email = context.user.email;
  if (!email) {
    return { ok: false, error: "Your account has no email address for the Paystack receipt." };
  }
  const baseUrl = appUrl();
  if (!baseUrl) {
    return { ok: false, error: "The app URL (NEXTAUTH_URL) isn't configured, so Paystack can't return here." };
  }

  const plan = await prisma.plan.findFirst({
    where: { code: code.data, active: true, isPublic: true, isTrial: false },
  });
  if (!plan) {
    return { ok: false, error: "That plan isn't available." };
  }
  if (!plan.paystackPlanCode) {
    return { ok: false, error: "That plan isn't connected to Paystack yet. Contact Sunleon." };
  }

  const now = new Date();
  const entitlements = await resolveEntitlements(prisma, context.organization.id, now);
  if (
    entitlements.source === "subscription" &&
    (entitlements.subscriptionStatus === "ACTIVE" || entitlements.subscriptionStatus === "PAST_DUE")
  ) {
    return {
      ok: false,
      error: "You already have a renewing subscription. Cancel it first; you can choose a new plan straight after.",
    };
  }

  const reference = `slv_${randomUUID()}`;
  await prisma.billingTransaction.create({
    data: {
      organizationId: context.organization.id,
      planId: plan.id,
      provider: "PAYSTACK",
      kind: "INITIAL",
      reference,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      customerEmail: email,
    },
  });

  try {
    const checkout = await getPaymentProvider().initializeCheckout({
      email,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      planCode: plan.paystackPlanCode,
      reference,
      callbackUrl: `${baseUrl}/dashboard/${context.organization.slug}/billing`,
    });
    await prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "billing.checkout_started",
        metadata: { reference, planCode: plan.code },
      },
    });
    return { ok: true, redirectUrl: checkout.authorizationUrl };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Checkout failed.";
    await prisma.billingTransaction.update({ where: { reference }, data: { status: "FAILED", failureReason: reason } });
    if (error instanceof PaymentProviderError || error instanceof MissingPaymentCredentialsError) {
      return { ok: false, error: `Couldn't start the Paystack checkout. ${reason}` };
    }
    throw error;
  }
}

/**
 * Called when Paystack sends the customer back. Asks Paystack directly whether the payment went
 * through and applies it through the same idempotent path as the webhook, so whichever arrives
 * first wins and the other is a no-op. The webhook remains the source of truth for renewals.
 */
export async function confirmCheckout(organizationSlug: string, reference: string): Promise<BillingActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const parsed = checkoutReferenceSchema.safeParse(reference);
  if (!parsed.success) {
    return { ok: false, error: "Invalid payment reference." };
  }
  const transaction = await prisma.billingTransaction.findFirst({
    where: { reference: parsed.data, organizationId: context.organization.id },
  });
  if (!transaction) {
    return { ok: false, error: "Payment not found for this organization." };
  }
  if (transaction.status === "SUCCESS") {
    return { ok: true, message: "Payment confirmed. Your plan is active." };
  }
  if (transaction.status !== "PENDING") {
    return { ok: false, error: `This payment was not completed (${transaction.status.toLowerCase()}).` };
  }
  if (!isPaymentConfigured()) {
    return { ok: false, error: PAYMENTS_BLOCKED_MESSAGE };
  }

  let charge;
  try {
    charge = await getPaymentProvider().verifyTransaction(parsed.data);
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      return { ok: false, error: "Couldn't check the payment with Paystack yet. Refresh in a minute." };
    }
    throw error;
  }
  if (charge.reference !== parsed.data) {
    return { ok: false, error: "Paystack returned a different payment." };
  }

  if (charge.status === "success") {
    const outcome = await prisma.$transaction((tx) => applySuccessfulCharge(tx, charge, new Date()));
    if (outcome.outcome === "rejected") {
      return { ok: false, error: "The payment didn't match the plan's price, so the plan wasn't activated. Contact Sunleon." };
    }
    return { ok: true, message: "Payment confirmed. Your plan is active." };
  }
  if (["failed", "abandoned", "reversed"].includes(charge.status)) {
    await prisma.billingTransaction.updateMany({
      where: { id: transaction.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: `Paystack status: ${charge.status}` },
    });
    return { ok: false, error: "The payment wasn't completed. You can try again." };
  }
  return { ok: true, message: "Paystack is still processing this payment. This page will update when it's confirmed." };
}

/**
 * Stops renewal. Access continues until the end of the period already paid for (entitlements key
 * off paidThroughAt), so cancelling never takes away time the customer paid for.
 */
export async function cancelSubscription(organizationSlug: string): Promise<BillingActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  const subscription = await prisma.subscription.findUnique({ where: { organizationId: context.organization.id } });
  if (!subscription || subscription.status === "CANCELED") {
    return { ok: false, error: "There's no renewing subscription to cancel." };
  }

  if (subscription.provider === "PAYSTACK") {
    if (!subscription.providerSubscriptionCode || !subscription.providerEmailToken) {
      return {
        ok: false,
        error: "Paystack hasn't confirmed this subscription's details yet. Try again in a few minutes.",
      };
    }
    if (!isPaymentConfigured()) {
      return { ok: false, error: PAYMENTS_BLOCKED_MESSAGE };
    }
    try {
      await getPaymentProvider().disableSubscription({
        subscriptionCode: subscription.providerSubscriptionCode,
        emailToken: subscription.providerEmailToken,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        return { ok: false, error: `Paystack couldn't cancel the subscription. ${error.message}` };
      }
      throw error;
    }
  }

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "billing.subscription_canceled",
        metadata: { provider: subscription.provider, paidThroughAt: subscription.paidThroughAt },
      },
    }),
  ]);
  return { ok: true, message: "Subscription cancelled. Your plan stays active until the end of the paid period." };
}

/** The most the owner will pay in overage per period. 0 = hard stop at the plan's included minutes. */
export async function updateOverageBudget(organizationSlug: string, formData: FormData): Promise<BillingActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  const parsed = overageBudgetSchema.safeParse({ budget: formData.get("budget") ?? "" });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid budget." };
  }

  await prisma.$transaction([
    prisma.organization.update({
      where: { id: context.organization.id },
      data: { overageBudgetMinor: parsed.data.budget },
    }),
    prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "billing.overage_budget_updated",
        metadata: { overageBudgetMinor: parsed.data.budget },
      },
    }),
  ]);
  return { ok: true, message: "Overage budget saved." };
}
