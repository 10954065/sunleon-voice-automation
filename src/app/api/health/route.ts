import { NextResponse } from "next/server";

import { prisma } from "@/server/db/client";

/**
 * Liveness for uptime monitors. Public, so it reports only up/down — no versions, hosts or
 * configuration. 503 when the database can't be reached.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
