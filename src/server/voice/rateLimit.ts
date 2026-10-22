import "server-only";

/**
 * Dev-only in-memory token bucket, scoped to this one server process. It stops a single
 * runaway client from minting unlimited real provider tokens on the public embed route,
 * but does NOT protect a multi-instance production deployment — resets on every restart
 * and is not shared across instances. Must be replaced with a durable limiter (e.g.
 * Upstash/Redis) before production; tracked in docs/KNOWN_LIMITATIONS.md.
 */
const buckets = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 10;

/**
 * On Vercel the platform overwrites X-Forwarded-For with the real client IP. On other hosts it
 * may be client-controlled, which is why IP-keyed limits are always paired with a per-agent
 * ceiling that no header can influence.
 */
export function clientIpFrom(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}

export function isRateLimited(key: string, maxPerWindow = DEFAULT_MAX_PER_WINDOW): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count += 1;
  return bucket.count > maxPerWindow;
}
