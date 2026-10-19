import { describe, expect, it } from "vitest";

import { fetchUrlSafely, UnsafeUrlError } from "@/server/knowledge/ssrf";

describe("fetchUrlSafely — shape and IP validation (no real network calls)", () => {
  it("rejects a non-HTTP(S) scheme before any network access", async () => {
    await expect(fetchUrlSafely("ftp://example.com/file")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a non-standard port", async () => {
    await expect(fetchUrlSafely("http://example.com:8080/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects localhost outright", async () => {
    await expect(fetchUrlSafely("http://localhost/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects the cloud metadata IP literal", async () => {
    await expect(fetchUrlSafely("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      UnsafeUrlError
    );
  });

  it("rejects a private RFC1918 IP literal", async () => {
    await expect(fetchUrlSafely("http://10.0.0.5/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
