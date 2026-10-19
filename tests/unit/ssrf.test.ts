import { describe, expect, it } from "vitest";

import { isPrivateOrReservedIp } from "@/server/knowledge/ssrf";

describe("isPrivateOrReservedIp", () => {
  it("blocks the AWS/GCP/Azure cloud metadata address", () => {
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
  });

  it("blocks loopback", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.5")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
  });

  it("does not block a public IP range used by 172.x outside the private block", () => {
    expect(isPrivateOrReservedIp("172.15.0.1")).toBe(false);
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false);
  });

  it("allows public addresses", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("blocks IPv6 unique-local and link-local ranges", () => {
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 addresses before checking", () => {
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:8.8.8.8")).toBe(false);
  });
});
