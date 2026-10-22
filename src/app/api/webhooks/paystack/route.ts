import { NextRequest, NextResponse } from "next/server";

import { handlePaystackWebhook } from "@/server/billing/webhooks";

/** Paystack event payloads are a few KB; anything far larger isn't a real event. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Paystack webhook receiver. Unauthenticated by design — the HMAC signature over the raw body is
 * the authentication, so the body is read as text and passed through untouched (re-serialising
 * parsed JSON would break the signature). Non-200 responses make Paystack redeliver.
 */
export async function POST(request: NextRequest) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ received: false }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ received: false }, { status: 413 });
  }

  const result = await handlePaystackWebhook({
    rawBody,
    signature: request.headers.get("x-paystack-signature"),
  });
  return NextResponse.json({ received: result.status === 200, result: result.result }, { status: result.status });
}
