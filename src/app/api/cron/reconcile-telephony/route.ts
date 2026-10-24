import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/server/auth/cron";
import { runJob } from "@/server/observability/jobs";
import { getTwilioCredentials } from "@/server/telephony/config";
import { reconcileTelephonyCalls } from "@/server/telephony/reconciliation";

/**
 * Daily: compares finished calls with Twilio's own call records (duration and price) and fills in
 * carrier usage for calls whose completed callback never arrived. See docs/USAGE_RECONCILIATION.md.
 */
export async function GET(request: NextRequest) {
  const authorization = authorizeCronRequest(request.headers.get("authorization"));
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const run = await runJob("reconcile-telephony", async () =>
    getTwilioCredentials() ? reconcileTelephonyCalls() : { skipped: "Twilio is not configured." }
  );
  return run.ok
    ? NextResponse.json(run.result, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "Reconciliation failed. See /admin/monitoring." }, { status: 500 });
}
