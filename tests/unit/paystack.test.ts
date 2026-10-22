import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  isPaystackCheckoutUrl,
  parseCharge,
  PaystackProvider,
  PaymentProviderError,
  verifyPaystackSignature,
} from "@/server/billing/paystack";

/**
 * These exercise our adapter against Paystack's documented request/response shapes with a fake
 * fetch. They are NOT evidence that a live Paystack account accepts these calls — that remains
 * BLOCKED on credentials (docs/PROVIDER_INTEGRATIONS.md).
 */
const SECRET = "sk_test_not_a_real_key";
const sign = (body: string, secret = SECRET) => createHmac("sha512", secret).update(body, "utf8").digest("hex");

describe("verifyPaystackSignature", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "slv_x" } });

  it("accepts the HMAC-SHA512 of the exact raw body (hex, case-insensitive)", () => {
    expect(verifyPaystackSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyPaystackSignature(body, sign(body).toUpperCase(), SECRET)).toBe(true);
  });

  it("rejects a tampered body, the wrong secret, and missing or malformed signatures", () => {
    expect(verifyPaystackSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, sign(body, "sk_test_other"), SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, null, SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, "", SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, "abc123", SECRET)).toBe(false);
    expect(verifyPaystackSignature(body, sign(body), "")).toBe(false);
  });
});

describe("parseCharge", () => {
  const base = { reference: "slv_1", status: "success", amount: 29900, currency: "ghs", paid_at: "2026-10-01T10:00:00.000Z" };

  it("normalises the plan code from a string, a plan object, or plan_object", () => {
    expect(parseCharge({ ...base, plan: "PLN_a" })?.planCode).toBe("PLN_a");
    expect(parseCharge({ ...base, plan: { plan_code: "PLN_b" } })?.planCode).toBe("PLN_b");
    expect(parseCharge({ ...base, plan: {}, plan_object: { plan_code: "PLN_c" } })?.planCode).toBe("PLN_c");
    expect(parseCharge({ ...base, plan: null })?.planCode).toBeNull();
  });

  it("upper-cases currency, parses paid_at, and reads the customer", () => {
    const charge = parseCharge({ ...base, customer: { customer_code: "CUS_1", email: "a@b.co" } });
    expect(charge).toMatchObject({
      currency: "GHS",
      amountMinor: 29900,
      customerCode: "CUS_1",
      customerEmail: "a@b.co",
      paidAt: new Date("2026-10-01T10:00:00.000Z"),
    });
  });

  it("returns null for payloads missing required fields", () => {
    expect(parseCharge({ status: "success" })).toBeNull();
    expect(parseCharge({ ...base, amount: "29900" })).toBeNull();
    expect(parseCharge(null)).toBeNull();
  });
});

describe("isPaystackCheckoutUrl", () => {
  it("only allows HTTPS Paystack hosts", () => {
    expect(isPaystackCheckoutUrl("https://checkout.paystack.com/abc")).toBe(true);
    expect(isPaystackCheckoutUrl("http://checkout.paystack.com/abc")).toBe(false);
    expect(isPaystackCheckoutUrl("https://paystack.com.evil.example/abc")).toBe(false);
    expect(isPaystackCheckoutUrl("https://evilpaystack.com/abc")).toBe(false);
    expect(isPaystackCheckoutUrl("not a url")).toBe(false);
  });
});

describe("PaystackProvider", () => {
  function fakeFetch(response: { status?: number; body: unknown }) {
    return vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status ?? 200 }));
  }

  it("initializes a checkout with the server-chosen amount, plan and reference", async () => {
    const fetchImpl = fakeFetch({
      body: { status: true, data: { authorization_url: "https://checkout.paystack.com/xyz", reference: "slv_1" } },
    });
    const provider = new PaystackProvider(SECRET, fetchImpl as unknown as typeof fetch);

    const result = await provider.initializeCheckout({
      email: "owner@example.com",
      amountMinor: 29900,
      currency: "GHS",
      planCode: "PLN_starter",
      reference: "slv_1",
      callbackUrl: "http://localhost:3000/dashboard/kofi/billing",
    });

    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/xyz");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: "owner@example.com",
      amount: 29900,
      currency: "GHS",
      plan: "PLN_starter",
      reference: "slv_1",
      callback_url: "http://localhost:3000/dashboard/kofi/billing",
    });
  });

  it("refuses to hand back a checkout link that isn't Paystack's", async () => {
    const provider = new PaystackProvider(
      SECRET,
      fakeFetch({ body: { status: true, data: { authorization_url: "https://phish.example/pay" } } }) as unknown as typeof fetch
    );
    await expect(
      provider.initializeCheckout({
        email: "a@b.co",
        amountMinor: 1,
        currency: "GHS",
        planCode: "PLN_x",
        reference: "slv_1",
        callbackUrl: "http://localhost:3000",
      })
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("turns API errors into PaymentProviderError without leaking the secret key", async () => {
    const provider = new PaystackProvider(
      SECRET,
      fakeFetch({ status: 400, body: { status: false, message: "Invalid plan" } }) as unknown as typeof fetch
    );
    const error = await provider.verifyTransaction("slv_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as Error).message).toContain("Invalid plan");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("reports network failures as PaymentProviderError", async () => {
    const provider = new PaystackProvider(SECRET, vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(provider.verifyTransaction("slv_1")).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("verifies a transaction by reference and disables a subscription with code and token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: true, data: { reference: "slv_1", status: "success", amount: 29900, currency: "GHS" } }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, message: "Subscription disabled successfully" })));
    const provider = new PaystackProvider(SECRET, fetchImpl as unknown as typeof fetch);

    expect(await provider.verifyTransaction("slv_1")).toMatchObject({ reference: "slv_1", status: "success" });
    await provider.disableSubscription({ subscriptionCode: "SUB_1", emailToken: "tok_1" });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.paystack.co/transaction/verify/slv_1");
    const [disableUrl, disableInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(disableUrl).toBe("https://api.paystack.co/subscription/disable");
    expect(JSON.parse(disableInit.body as string)).toEqual({ code: "SUB_1", token: "tok_1" });
  });
});
