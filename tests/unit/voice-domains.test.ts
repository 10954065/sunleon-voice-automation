import { describe, expect, it } from "vitest";

import { extractHostname, isEmbedHostAllowed } from "@/server/voice/domains";

describe("extractHostname", () => {
  it("returns the lowercase hostname from a URL-valued header", () => {
    expect(extractHostname("https://WWW.Example.com.gh/contact?x=1")).toBe("www.example.com.gh");
  });

  it("returns null for a missing or unparseable header", () => {
    expect(extractHostname(null)).toBeNull();
    expect(extractHostname("")).toBeNull();
    expect(extractHostname("not a url")).toBeNull();
  });
});

describe("isEmbedHostAllowed", () => {
  it("denies everything when the allowlist is empty (secure by default)", () => {
    expect(isEmbedHostAllowed("example.com", [])).toBe(false);
  });

  it("denies a missing hostname", () => {
    expect(isEmbedHostAllowed(null, ["example.com"])).toBe(false);
  });

  it("allows an exact, case-insensitive match", () => {
    expect(isEmbedHostAllowed("example.com", ["Example.COM"])).toBe(true);
  });

  it("does not treat a subdomain or a lookalike as a match", () => {
    expect(isEmbedHostAllowed("shop.example.com", ["example.com"])).toBe(false);
    expect(isEmbedHostAllowed("example.com.evil.net", ["example.com"])).toBe(false);
    expect(isEmbedHostAllowed("evilexample.com", ["example.com"])).toBe(false);
  });
});
