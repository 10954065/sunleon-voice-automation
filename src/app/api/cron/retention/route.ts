import { NextRequest, NextResponse } from "next/server";

import { authorizeCronRequest } from "@/server/auth/cron";
import { applyRetention } from "@/server/privacy/retention";
import { runJob } from "@/server/observability/jobs";

/**
 * Daily: deletes transcripts and leads past each organization's retention window, and old
 * monitoring records. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  const authorization = authorizeCronRequest(request.headers.get("authorization"));
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const run = await runJob("retention", () => applyRetention());
  return run.ok
    ? NextResponse.json(run.result, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "Retention failed. See /admin/monitoring." }, { status: 500 });
}
