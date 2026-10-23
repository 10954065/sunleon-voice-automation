import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/server/auth/cron";
import { sweepStaleSessions } from "@/server/billing/sweeper";
import { runJob } from "@/server/observability/jobs";

/**
 * Backstop that closes abandoned voice sessions platform-wide and charges them their reservation.
 * Session preparation already sweeps its own organization, so this only matters for organizations
 * that stop starting sessions. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  const authorization = authorizeCronRequest(request.headers.get("authorization"));
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const run = await runJob("sweep-sessions", () => sweepStaleSessions());
  return run.ok
    ? NextResponse.json(run.result, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "The sweep failed. See /admin/monitoring." }, { status: 500 });
}
