import "server-only";

import { addMonthsUtc, monthsElapsed } from "@/lib/billing";
import type { ChargeDetails } from "./paystack";
import type { BillingTransaction, Plan, Prisma } from "@/generated/prisma/client";

export type ChargeOutcome =
  | { outcome: "activated" | "renewed" | "rejected"; organizationId: string; note?: string }
  | { outcome: "duplicate"; organizationId?: string; note?: string }
  | { outcome: "unmapped" | "ignored"; note: string };

/** Thrown when an event arrived before the one it depends on; the webhook answers 503 so Paystack retries it. */
export class RetryLaterError extends Error {}

function chargeMismatch(charge: ChargeDetails, expected: { amountMinor: number; currency: string; planCode: string | null }) {
  if (charge.amountMinor !== expected.amountMinor) {
    return `amount ${charge.amountMinor} != expected ${expected.amountMinor}`;
  }
  if (charge.currency !== expected.currency.toUpperCase()) {
    return `currency ${charge.currency} != expected ${expected.currency}`;
  }
  if (expected.planCode && charge.planCode && charge.planCode !== expected.planCode) {
    return `plan ${charge.planCode} != expected ${expected.planCode}`;
  }
  return null;
}

/**
 * Applies a successful Paystack charge. Tenant mapping only ever comes from records we created
 * (our own checkout reference, or the customer and plan codes stored on a subscription that one of
 * our checkouts started) — never from metadata in the payload. Amount, currency and plan must
 * match what we expected, so a tampered or mistaken payment can't grant a plan it didn't pay for.
 * Shared by the webhook and the post-checkout verification; both are idempotent per reference.
 */
export async function applySuccessfulCharge(
  tx: Prisma.TransactionClient,
  charge: ChargeDetails,
  now: Date
): Promise<ChargeOutcome> {
  if (charge.status !== "success") {
    return { outcome: "ignored", note: `charge status is ${charge.status}` };
  }
  const transaction = await tx.billingTransaction.findUnique({
    where: { reference: charge.reference },
    include: { plan: true },
  });
  return transaction
    ? applyCheckoutCharge(tx, transaction, charge, now)
    : applyRenewalCharge(tx, charge, now);
}

async function applyCheckoutCharge(
  tx: Prisma.TransactionClient,
  transaction: BillingTransaction & { plan: Plan | null },
  charge: ChargeDetails,
  now: Date
): Promise<ChargeOutcome> {
  const organizationId = transaction.organizationId;
  if (transaction.status !== "PENDING") {
    return { outcome: "duplicate", organizationId, note: `transaction already ${transaction.status}` };
  }

  const mismatch = transaction.plan
    ? chargeMismatch(charge, {
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        planCode: transaction.plan.paystackPlanCode,
      })
    : "checkout has no plan";
  if (mismatch || !transaction.plan) {
    await tx.billingTransaction.updateMany({
      where: { id: transaction.id, status: "PENDING" },
      data: { status: "REJECTED", failureReason: mismatch },
    });
    await tx.auditLog.create({
      data: { organizationId, action: "billing.charge_rejected", metadata: { reference: charge.reference, reason: mismatch } },
    });
    return { outcome: "rejected", organizationId, note: mismatch ?? undefined };
  }

  const paidAt = charge.paidAt ?? now;
  const claimed = await tx.billingTransaction.updateMany({
    where: { id: transaction.id, status: "PENDING" },
    data: { status: "SUCCESS", paidAt },
  });
  if (claimed.count !== 1) {
    return { outcome: "duplicate", organizationId };
  }

  // A new checkout starts a fresh subscription: new anchor, and the provider subscription codes
  // arrive separately in subscription.create.
  const subscriptionData = {
    planId: transaction.plan.id,
    status: "ACTIVE" as const,
    provider: "PAYSTACK" as const,
    billingAnchorAt: paidAt,
    paidThroughAt: addMonthsUtc(paidAt, 1),
    providerCustomerCode: charge.customerCode,
    providerSubscriptionCode: null,
    providerEmailToken: null,
    canceledAt: null,
  };
  await tx.subscription.upsert({
    where: { organizationId },
    create: { organizationId, ...subscriptionData },
    update: subscriptionData,
  });
  await tx.auditLog.create({
    data: {
      organizationId,
      action: "billing.subscription_activated",
      metadata: { reference: charge.reference, planCode: transaction.plan.code, amountMinor: charge.amountMinor },
    },
  });
  return { outcome: "activated", organizationId };
}

async function applyRenewalCharge(
  tx: Prisma.TransactionClient,
  charge: ChargeDetails,
  now: Date
): Promise<ChargeOutcome> {
  if (!charge.customerCode || !charge.planCode) {
    return { outcome: "unmapped", note: "charge has no customer or plan code and no matching checkout" };
  }
  const subscription = await tx.subscription.findFirst({
    where: {
      provider: "PAYSTACK",
      providerCustomerCode: charge.customerCode,
      plan: { paystackPlanCode: charge.planCode },
    },
    include: { plan: true },
  });
  if (!subscription) {
    return { outcome: "unmapped", note: "no subscription for this customer and plan" };
  }

  const organizationId = subscription.organizationId;
  const paidAt = charge.paidAt ?? now;
  const mismatch = chargeMismatch(charge, {
    amountMinor: subscription.plan.priceMinor,
    currency: subscription.plan.currency,
    planCode: subscription.plan.paystackPlanCode,
  });

  // The unique reference makes a concurrent duplicate fail here and roll the whole event back.
  await tx.billingTransaction.create({
    data: {
      organizationId,
      planId: subscription.planId,
      provider: "PAYSTACK",
      kind: "RENEWAL",
      reference: charge.reference,
      status: mismatch ? "REJECTED" : "SUCCESS",
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      customerEmail: charge.customerEmail,
      paidAt: mismatch ? null : paidAt,
      failureReason: mismatch,
    },
  });
  if (mismatch) {
    await tx.auditLog.create({
      data: { organizationId, action: "billing.charge_rejected", metadata: { reference: charge.reference, reason: mismatch } },
    });
    return { outcome: "rejected", organizationId, note: mismatch };
  }

  // On time: extend by one month on the same anchor, so the current period doesn't move.
  // Late (after the subscription lapsed): start a fresh anchor at the payment.
  const onTime = paidAt < subscription.paidThroughAt;
  const billingAnchorAt = onTime ? subscription.billingAnchorAt : paidAt;
  const paidThroughAt = onTime
    ? addMonthsUtc(subscription.billingAnchorAt, monthsElapsed(subscription.billingAnchorAt, subscription.paidThroughAt) + 1)
    : addMonthsUtc(paidAt, 1);

  await tx.subscription.update({
    where: { id: subscription.id },
    data: { status: "ACTIVE", billingAnchorAt, paidThroughAt },
  });
  await tx.auditLog.create({
    data: { organizationId, action: "billing.subscription_renewed", metadata: { reference: charge.reference, paidThroughAt } },
  });
  return { outcome: "renewed", organizationId };
}

export type SubscriptionEventOutcome =
  | { outcome: "updated"; organizationId: string; note?: string }
  | { outcome: "unmapped"; note: string };

/** subscription.create: stores the codes Paystack needs to cancel the subscription later. */
export async function applySubscriptionCreated(
  tx: Prisma.TransactionClient,
  input: { subscriptionCode: string; emailToken: string | null; customerCode: string | null; customerEmail: string | null; planCode: string | null }
): Promise<SubscriptionEventOutcome> {
  if (!input.customerCode || !input.planCode) {
    return { outcome: "unmapped", note: "missing customer or plan code" };
  }
  const subscription = await tx.subscription.findFirst({
    where: { provider: "PAYSTACK", providerCustomerCode: input.customerCode, plan: { paystackPlanCode: input.planCode } },
  });
  if (!subscription) {
    // Paystack doesn't guarantee event order. If one of our checkouts for this customer and plan
    // is still waiting for its charge.success, ask Paystack to redeliver this event later.
    const pending = input.customerEmail
      ? await tx.billingTransaction.findFirst({
          where: {
            status: "PENDING",
            customerEmail: { equals: input.customerEmail, mode: "insensitive" },
            plan: { paystackPlanCode: input.planCode },
          },
        })
      : null;
    if (pending) {
      throw new RetryLaterError("subscription.create arrived before its charge.success");
    }
    return { outcome: "unmapped", note: "no subscription for this customer and plan" };
  }
  await tx.subscription.update({
    where: { id: subscription.id },
    data: { providerSubscriptionCode: input.subscriptionCode, providerEmailToken: input.emailToken },
  });
  return { outcome: "updated", organizationId: subscription.organizationId };
}

/** subscription.not_renew, subscription.disable and invoice.payment_failed, by our stored subscription code. */
export async function applySubscriptionStatusEvent(
  tx: Prisma.TransactionClient,
  input: { subscriptionCode: string; status: "NON_RENEWING" | "CANCELED" | "PAST_DUE"; now: Date }
): Promise<SubscriptionEventOutcome> {
  const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionCode: input.subscriptionCode } });
  if (!subscription) {
    return { outcome: "unmapped", note: "unknown subscription code" };
  }
  // A cancelled subscription stays cancelled; later "not renewing" or "payment failed" notices don't revive it.
  if (subscription.status === "CANCELED" && input.status !== "CANCELED") {
    return { outcome: "updated", organizationId: subscription.organizationId, note: "already cancelled" };
  }
  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: input.status,
      ...(input.status === "CANCELED" && !subscription.canceledAt && { canceledAt: input.now }),
    },
  });
  await tx.auditLog.create({
    data: {
      organizationId: subscription.organizationId,
      action: "billing.subscription_status_changed",
      metadata: { from: subscription.status, to: input.status },
    },
  });
  return { outcome: "updated", organizationId: subscription.organizationId };
}
