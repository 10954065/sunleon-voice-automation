import "server-only";

import { timingSafeEqual } from "node:crypto";

export type CronAuthorization = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Compared in constant time; with no secret
 * configured every request is refused (503), so an unset variable never leaves a job open to the internet.
 */
export function authorizeCronRequest(authorizationHeader: string | null): CronAuthorization {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 503, error: "CRON_SECRET is not configured." };
  }
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(authorizationHeader ?? "", "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}
