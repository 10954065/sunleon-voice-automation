import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIpFrom, isRateLimited } from "@/server/voice/rateLimit";

describe("clientIpFrom", () => {
  it("uses the first X-Forwarded-For entry", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "41.66.1.2, 10.0.0.1" }))).toBe("41.66.1.2");
  });

  it("falls back to X-Real-IP, then to a shared 'unknown' bucket", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "41.66.1.3" }))).toBe("41.66.1.3");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});

describe("isRateLimited", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit, then blocks", () => {
    const key = `test-limit-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(isRateLimited(key, 3)).toBe(false);
    }
    expect(isRateLimited(key, 3)).toBe(true);
  });

  it("tracks keys independently", () => {
    const keyA = `test-a-${Math.random()}`;
    const keyB = `test-b-${Math.random()}`;
    expect(isRateLimited(keyA, 1)).toBe(false);
    expect(isRateLimited(keyA, 1)).toBe(true);
    expect(isRateLimited(keyB, 1)).toBe(false);
  });

  it("resets once the window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const key = `test-window-${Math.random()}`;
    expect(isRateLimited(key, 1)).toBe(false);
    expect(isRateLimited(key, 1)).toBe(true);
    vi.setSystemTime(new Date("2026-10-19T10:01:01Z"));
    expect(isRateLimited(key, 1)).toBe(false);
  });
});
