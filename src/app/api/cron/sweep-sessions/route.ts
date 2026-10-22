import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { sweepStaleSessions } from "@/server/billing/sweeper";

function isAuthorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(header ?? "", "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Backstop that closes abandoned voice sessions platform-wide and charges them their reservation.
 * Session preparation already sweeps its own organization, so this only matters for organizations
 * that stop starting sessions. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (!isAuthorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const result = await sweepStaleSessions();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
