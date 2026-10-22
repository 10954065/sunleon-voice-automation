import "server-only";

/** Extracts a lowercase hostname from a URL-valued header (e.g. Referer), or null. */
export function extractHostname(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }
  try {
    return new URL(headerValue).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Secure by default: an empty allowlist or a missing hostname denies. Exact hostname match only. */
export function isEmbedHostAllowed(hostname: string | null, allowedDomains: string[]): boolean {
  if (!hostname || allowedDomains.length === 0) {
    return false;
  }
  const normalized = allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  return normalized.includes(hostname);
}
