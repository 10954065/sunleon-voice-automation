import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Blocks SSRF via website knowledge sources: private/reserved/loopback/link-local
 * addresses (this also covers the 169.254.169.254 cloud metadata endpoint on AWS/GCP/Azure),
 * non-HTTP(S) schemes, and non-standard ports. This is a defense layer, not an exhaustive
 * IP-range database — review and extend before handling untrusted traffic at scale.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 0) return true; // 0.0.0.0/8
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(lower.replace("::ffff:", ""));
    }
    return false;
  }

  return true; // unrecognized — fail closed
}

async function assertHostIsSafe(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new UnsafeUrlError(`Refusing to fetch private/reserved address: ${address}`);
    }
  }
}

function assertSafeUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeUrlError(`Unsupported port: ${url.port}`);
  }
  if (url.hostname === "localhost") {
    throw new UnsafeUrlError("Refusing to fetch localhost");
  }
}

/**
 * Fetches a URL with SSRF protections, following redirects manually (each hop is
 * re-validated — a safe initial URL can still redirect to an internal address).
 */
export async function fetchUrlSafely(
  urlString: string
): Promise<{ html: string; finalUrl: string }> {
  let currentUrl = new URL(urlString);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertSafeUrlShape(currentUrl);
    await assertHostIsSafe(currentUrl.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "SunleonVoiceBot/0.1 (+knowledge-ingestion)" },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new UnsafeUrlError("Redirect response had no Location header");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new UnsafeUrlError(`Fetch failed with status ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new UnsafeUrlError("Response exceeds maximum allowed size");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new UnsafeUrlError("Response exceeds maximum allowed size");
    }

    return { html: Buffer.from(buffer).toString("utf-8"), finalUrl: currentUrl.toString() };
  }

  throw new UnsafeUrlError("Too many redirects");
}
