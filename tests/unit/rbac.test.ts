import { describe, expect, it } from "vitest";

import { requireRole, TenantAccessError } from "@/server/auth/tenant";

describe("requireRole", () => {
  it("allows a role that meets the minimum requirement", () => {
    expect(() => requireRole("OWNER", ["ADMIN"])).not.toThrow();
  });

  it("allows a higher-ranked role when a lower one is required", () => {
    expect(() => requireRole("SUPER_ADMIN", ["OWNER"])).not.toThrow();
  });

  it("rejects a role below the minimum requirement", () => {
    expect(() => requireRole("ANALYST", ["OWNER", "ADMIN"])).toThrow(TenantAccessError);
  });

  it("rejects AGENT_MANAGER for an OWNER-only action", () => {
    expect(() => requireRole("AGENT_MANAGER", ["OWNER"])).toThrow(TenantAccessError);
  });
});
