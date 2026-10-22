import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Paystack adapter. Verified against Paystack's own published sources (their documentation
 * repository and official Magento plugin, checked 2026-10-22) — NOT yet exercised against a live
 * Paystack account, which is BLOCKED on credentials (docs/PROVIDER_INTEGRATIONS.md):
 * - Webhooks carry X-Paystack-Signature: HMAC-SHA512 of the raw body, keyed with the secret key.
 * - A subscription starts by initializing a transaction with a plan code.
 * - Subscriptions are cancelled with POST /subscription/disable { code, token (email_token) }.
 */
const PAYSTACK_API_BASE = "https://api.paystack.co";
const REQUEST_TIMEOUT_MS = 10_000;

export class MissingPaymentCredentialsError extends Error {
  constructor() {
    super("Payments aren't configured yet: PAYSTACK_SECRET_KEY is not set. See docs/PROVIDER_INTEGRATIONS.md.");
  }
}

export class PaymentProviderError extends Error {}

export function getPaystackSecretKey(): string | null {
  return process.env.PAYSTACK_SECRET_KEY?.trim() || null;
}

export function isPaymentConfigured(): boolean {
  return getPaystackSecretKey() !== null;
}

/** Constant-time check of X-Paystack-Signature against the raw request body. */
export function verifyPaystackSignature(rawBody: string, signature: string | null, secretKey: string): boolean {
  if (!signature || !secretKey) {
    return false;
  }
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody, "utf8").digest("hex"), "utf8");
  const received = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface ChargeDetails {
  reference: string;
  status: string;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  customerCode: string | null;
  customerEmail: string | null;
  planCode: string | null;
}

const planRefSchema = z.union([z.string(), z.object({ plan_code: z.string().nullish() }).loose()]).nullish();

const chargeSchema = z
  .object({
    reference: z.string().min(1),
    status: z.string(),
    amount: z.number().int().nonnegative(),
    currency: z.string().min(3),
    paid_at: z.string().nullish(),
    paidAt: z.string().nullish(),
    customer: z.object({ customer_code: z.string().nullish(), email: z.string().nullish() }).loose().nullish(),
    plan: planRefSchema,
    plan_object: z.object({ plan_code: z.string().nullish() }).loose().nullish(),
  })
  .loose();

/** Normalises a charge from either a charge.success webhook or the verify-transaction endpoint. */
export function parseCharge(data: unknown): ChargeDetails | null {
  const parsed = chargeSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const charge = parsed.data;
  const planCode =
    (typeof charge.plan === "string" ? charge.plan : charge.plan?.plan_code) || charge.plan_object?.plan_code || null;
  const paidAtRaw = charge.paid_at ?? charge.paidAt ?? null;
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
  return {
    reference: charge.reference,
    status: charge.status,
    amountMinor: charge.amount,
    currency: charge.currency.toUpperCase(),
    paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
    customerCode: charge.customer?.customer_code || null,
    customerEmail: charge.customer?.email || null,
    planCode,
  };
}

export interface PaymentProvider {
  initializeCheckout(input: {
    email: string;
    amountMinor: number;
    currency: string;
    planCode: string;
    reference: string;
    callbackUrl: string;
  }): Promise<{ authorizationUrl: string }>;
  verifyTransaction(reference: string): Promise<ChargeDetails>;
  disableSubscription(input: { subscriptionCode: string; emailToken: string }): Promise<void>;
}

// Error responses and some successes (e.g. subscription/disable) carry no `data` field.
const apiEnvelopeSchema = z.object({ status: z.boolean(), message: z.string().optional(), data: z.unknown().optional() });

export class PaystackProvider implements PaymentProvider {
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(secretKey: string, fetchImpl: typeof fetch = fetch) {
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
  }

  private async request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${PAYSTACK_API_BASE}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      throw new PaymentProviderError(`Couldn't reach Paystack (${error instanceof Error ? error.name : "network error"}).`);
    }
    const envelope = apiEnvelopeSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !envelope.success || !envelope.data.status) {
      const message = envelope.success ? envelope.data.message : undefined;
      throw new PaymentProviderError(`Paystack request failed (${response.status}${message ? `: ${message}` : ""}).`);
    }
    return envelope.data.data;
  }

  async initializeCheckout(input: {
    email: string;
    amountMinor: number;
    currency: string;
    planCode: string;
    reference: string;
    callbackUrl: string;
  }): Promise<{ authorizationUrl: string }> {
    const data = await this.request("/transaction/initialize", {
      method: "POST",
      body: {
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        plan: input.planCode,
        reference: input.reference,
        callback_url: input.callbackUrl,
      },
    });
    const parsed = z.object({ authorization_url: z.string() }).loose().safeParse(data);
    if (!parsed.success || !isPaystackCheckoutUrl(parsed.data.authorization_url)) {
      throw new PaymentProviderError("Paystack returned an unexpected checkout link.");
    }
    return { authorizationUrl: parsed.data.authorization_url };
  }

  async verifyTransaction(reference: string): Promise<ChargeDetails> {
    const data = await this.request(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    const charge = parseCharge(data);
    if (!charge) {
      throw new PaymentProviderError("Paystack returned an unexpected transaction shape.");
    }
    return charge;
  }

  async disableSubscription(input: { subscriptionCode: string; emailToken: string }): Promise<void> {
    await this.request("/subscription/disable", {
      method: "POST",
      body: { code: input.subscriptionCode, token: input.emailToken },
    });
  }
}

/** We only ever redirect a customer to Paystack's own HTTPS checkout, never to an arbitrary URL. */
export function isPaystackCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paystack.com" || url.hostname.endsWith(".paystack.com"));
  } catch {
    return false;
  }
}

export function getPaymentProvider(): PaymentProvider {
  const secretKey = getPaystackSecretKey();
  if (!secretKey) {
    throw new MissingPaymentCredentialsError();
  }
  return new PaystackProvider(secretKey);
}
