import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { prisma } from "@/server/db/client";
import { Prisma } from "@/generated/prisma/client";
import {
  getPaystackSecretKey,
  parseCharge,
  PaystackProvider,
  PaymentProviderError,
  verifyPaystackSignature,
  type PaymentProvider,
} from "./paystack";
import {
  applySubscriptionCreated,
  applySubscriptionStatusEvent,
  applySuccessfulCharge,
  RetryLaterError,
} from "./charges";

export interface WebhookResult {
  status: number;
  result: "processed" | "ignored" | "duplicate" | "invalid_signature" | "not_configured" | "malformed" | "retry";
}

const eventSchema = z.object({ event: z.string().min(1), data: z.unknown() });

const subscriptionCreatedSchema = z
  .object({
    subscription_code: z.string().min(1),
    email_token: z.string().nullish(),
    customer: z.object({ customer_code: z.string().nullish(), email: z.string().nullish() }).loose().nullish(),
    plan: z.object({ plan_code: z.string().nullish() }).loose().nullish(),
  })
  .loose();

const subscriptionCodeSchema = z.object({ subscription_code: z.string().min(1) }).loose();
const invoiceSchema = z.object({ subscription: subscriptionCodeSchema }).loose();

type Handled = { status: "PROCESSED" | "IGNORED"; organizationId?: string; summary: Record<string, string | null>; note?: string };

/**
 * Entry point for Paystack's webhook. Order of checks:
 * 1. No secret configured → 503: we can't verify, so we never act on an unverified payload.
 * 2. Signature over the exact raw body → 401 if it doesn't match. Nothing is read before this.
 * 3. SHA-256 of the body as an idempotency key: an identical redelivery is acknowledged without
 *    re-running anything. Effects and the event record commit in one transaction, so a crash
 *    mid-way leaves no record and Paystack's retry re-runs it cleanly.
 * 4. charge.success is re-verified with Paystack's API before anything is granted.
 */
export async function handlePaystackWebhook(params: {
  rawBody: string;
  signature: string | null;
  provider?: PaymentProvider;
  now?: Date;
}): Promise<WebhookResult> {
  const secretKey = getPaystackSecretKey();
  if (!secretKey) {
    return { status: 503, result: "not_configured" };
  }
  if (!verifyPaystackSignature(params.rawBody, params.signature, secretKey)) {
    return { status: 401, result: "invalid_signature" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(params.rawBody);
  } catch {
    return { status: 400, result: "malformed" };
  }
  const event = eventSchema.safeParse(parsedJson);
  if (!event.success) {
    return { status: 400, result: "malformed" };
  }

  const eventKey = createHash("sha256").update(params.rawBody, "utf8").digest("hex");
  const seen = await prisma.paymentWebhookEvent.findUnique({
    where: { provider_eventKey: { provider: "PAYSTACK", eventKey } },
  });
  if (seen) {
    return { status: 200, result: "duplicate" };
  }

  const now = params.now ?? new Date();
  const provider = params.provider ?? new PaystackProvider(secretKey);

  try {
    // Network verification happens before the transaction so no database lock waits on Paystack.
    const verifiedCharge =
      event.data.event === "charge.success" ? await verifyChargeWithProvider(event.data.data, provider) : null;

    const handled = await prisma.$transaction(async (tx) => {
      const result = await dispatch(tx, event.data.event, event.data.data, verifiedCharge, now);
      await tx.paymentWebhookEvent.create({
        data: {
          provider: "PAYSTACK",
          eventKey,
          eventType: event.data.event,
          status: result.status,
          organizationId: result.organizationId ?? null,
          summary: result.summary,
          note: result.note ?? null,
        },
      });
      return result;
    });
    return { status: 200, result: handled.status === "PROCESSED" ? "processed" : "ignored" };
  } catch (error) {
    if (error instanceof RetryLaterError || error instanceof PaymentProviderError) {
      return { status: 503, result: "retry" };
    }
    // A concurrent delivery of the same event (or the same charge reference) won the race.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { status: 200, result: "duplicate" };
    }
    throw error;
  }
}

async function verifyChargeWithProvider(data: unknown, provider: PaymentProvider) {
  const charge = parseCharge(data);
  if (!charge) {
    return null;
  }
  // The signed payload says it succeeded; Paystack's API must agree before anything is granted.
  return provider.verifyTransaction(charge.reference);
}

async function dispatch(
  tx: Prisma.TransactionClient,
  eventType: string,
  data: unknown,
  verifiedCharge: Awaited<ReturnType<typeof verifyChargeWithProvider>>,
  now: Date
): Promise<Handled> {
  switch (eventType) {
    case "charge.success": {
      if (!verifiedCharge) {
        return { status: "IGNORED", summary: {}, note: "unrecognised charge payload" };
      }
      const outcome = await applySuccessfulCharge(tx, verifiedCharge, now);
      return {
        status: outcome.outcome === "unmapped" || outcome.outcome === "ignored" ? "IGNORED" : "PROCESSED",
        organizationId: "organizationId" in outcome ? outcome.organizationId : undefined,
        summary: { reference: verifiedCharge.reference, planCode: verifiedCharge.planCode, outcome: outcome.outcome },
        note: outcome.note,
      };
    }
    case "subscription.create": {
      const parsed = subscriptionCreatedSchema.safeParse(data);
      if (!parsed.success) {
        return { status: "IGNORED", summary: {}, note: "unrecognised subscription payload" };
      }
      const outcome = await applySubscriptionCreated(tx, {
        subscriptionCode: parsed.data.subscription_code,
        emailToken: parsed.data.email_token ?? null,
        customerCode: parsed.data.customer?.customer_code ?? null,
        customerEmail: parsed.data.customer?.email ?? null,
        planCode: parsed.data.plan?.plan_code ?? null,
      });
      return subscriptionResult(outcome, parsed.data.subscription_code);
    }
    case "subscription.not_renew":
    case "subscription.disable": {
      const parsed = subscriptionCodeSchema.safeParse(data);
      if (!parsed.success) {
        return { status: "IGNORED", summary: {}, note: "unrecognised subscription payload" };
      }
      const outcome = await applySubscriptionStatusEvent(tx, {
        subscriptionCode: parsed.data.subscription_code,
        status: eventType === "subscription.disable" ? "CANCELED" : "NON_RENEWING",
        now,
      });
      return subscriptionResult(outcome, parsed.data.subscription_code);
    }
    case "invoice.payment_failed": {
      const parsed = invoiceSchema.safeParse(data);
      if (!parsed.success) {
        return { status: "IGNORED", summary: {}, note: "unrecognised invoice payload" };
      }
      const code = parsed.data.subscription.subscription_code;
      const outcome = await applySubscriptionStatusEvent(tx, { subscriptionCode: code, status: "PAST_DUE", now });
      return subscriptionResult(outcome, code);
    }
    default:
      return { status: "IGNORED", summary: {}, note: "event type not used" };
  }
}

function subscriptionResult(
  outcome: Awaited<ReturnType<typeof applySubscriptionStatusEvent>>,
  subscriptionCode: string
): Handled {
  return outcome.outcome === "updated"
    ? { status: "PROCESSED", organizationId: outcome.organizationId, summary: { subscriptionCode }, note: outcome.note }
    : { status: "IGNORED", summary: { subscriptionCode }, note: outcome.note };
}
