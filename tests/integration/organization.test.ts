import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "./helpers";

const mockUser = { id: "", email: "owner@example.com", name: "Owner" };

vi.mock("@/server/auth/session", () => ({
  requireCurrentUser: vi.fn(async () => mockUser),
}));

const { createOrganization } = await import("@/server/actions/organization");

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return form;
}

describe("createOrganization", () => {
  beforeEach(async () => {
    await resetDatabase();
    const user = await prisma.user.create({
      data: { email: "owner@example.com", name: "Owner", passwordHash: "x" },
    });
    mockUser.id = user.id;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("creates an organization and makes the creator its OWNER", async () => {
    const result = await createOrganization(formData({ name: "Kente & Co." }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: result.slug } });
    expect(org.name).toBe("Kente & Co.");

    const membership = await prisma.membership.findFirstOrThrow({
      where: { organizationId: org.id, userId: mockUser.id },
    });
    expect(membership.role).toBe("OWNER");
  });

  it("records an audit log entry for organization creation", async () => {
    const result = await createOrganization(formData({ name: "Second Org" }));
    if (!result.ok) throw new Error("expected success");

    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: result.slug } });
    const auditEntry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.id, action: "org.created" },
    });
    expect(auditEntry.actorUserId).toBe(mockUser.id);
  });

  it("appends a numeric suffix when two organizations share a slug base", async () => {
    const first = await createOrganization(formData({ name: "Accra Traders" }));
    const second = await createOrganization(formData({ name: "Accra Traders" }));

    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(first.slug).toBe("accra-traders");
    expect(second.slug).toBe("accra-traders-2");
  });

  it("rejects a name that is too short", async () => {
    const result = await createOrganization(formData({ name: "A" }));
    expect(result.ok).toBe(false);
  });
});
