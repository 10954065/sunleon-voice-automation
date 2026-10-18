import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "./helpers";

type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST" | "SUPER_ADMIN";
  membershipId: string;
};

let mockContext: MockContext;

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => mockContext),
}));

const { inviteMember, changeMemberRole } = await import("@/server/actions/membership");

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return form;
}

describe("membership actions", () => {
  beforeEach(async () => {
    await resetDatabase();

    const organization = await prisma.organization.create({
      data: { name: "Org A", slug: "org-a" },
    });
    const owner = await prisma.user.create({
      data: { email: "owner@example.com", name: "Owner", passwordHash: "x" },
    });
    const ownerMembership = await prisma.membership.create({
      data: { userId: owner.id, organizationId: organization.id, role: "OWNER" },
    });

    mockContext = {
      user: owner,
      organization,
      role: "OWNER",
      membershipId: ownerMembership.id,
    };
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("inviteMember", () => {
    it("adds an existing registered user to the organization", async () => {
      await prisma.user.create({
        data: { email: "newhire@example.com", name: "New Hire", passwordHash: "x" },
      });

      const result = await inviteMember(
        "org-a",
        formData({ email: "newhire@example.com", role: "ANALYST" })
      );

      expect(result.ok).toBe(true);
      const membership = await prisma.membership.findFirst({
        where: { organizationId: mockContext.organization.id, user: { email: "newhire@example.com" } },
      });
      expect(membership?.role).toBe("ANALYST");
    });

    it("rejects inviting an email with no existing account", async () => {
      const result = await inviteMember(
        "org-a",
        formData({ email: "ghost@example.com", role: "ANALYST" })
      );
      expect(result.ok).toBe(false);
    });

    it("rejects inviting someone who is already a member", async () => {
      const existing = await prisma.user.create({
        data: { email: "already@example.com", name: "Already", passwordHash: "x" },
      });
      await prisma.membership.create({
        data: { userId: existing.id, organizationId: mockContext.organization.id, role: "ANALYST" },
      });

      const result = await inviteMember(
        "org-a",
        formData({ email: "already@example.com", role: "ADMIN" })
      );
      expect(result.ok).toBe(false);
    });

    it("rejects an ANALYST trying to invite members", async () => {
      mockContext = { ...mockContext, role: "ANALYST" };
      await prisma.user.create({
        data: { email: "newhire2@example.com", name: "New Hire", passwordHash: "x" },
      });

      await expect(
        inviteMember("org-a", formData({ email: "newhire2@example.com", role: "ANALYST" }))
      ).rejects.toThrow();
    });
  });

  describe("changeMemberRole", () => {
    it("lets an OWNER change another member's role", async () => {
      const member = await prisma.user.create({
        data: { email: "member@example.com", name: "Member", passwordHash: "x" },
      });
      const membership = await prisma.membership.create({
        data: { userId: member.id, organizationId: mockContext.organization.id, role: "ANALYST" },
      });

      const result = await changeMemberRole(
        "org-a",
        formData({ membershipId: membership.id, role: "ADMIN" })
      );

      expect(result.ok).toBe(true);
      const updated = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
      expect(updated.role).toBe("ADMIN");
    });

    it("rejects an ADMIN trying to change a role (OWNER-only action)", async () => {
      mockContext = { ...mockContext, role: "ADMIN" };
      const member = await prisma.user.create({
        data: { email: "member2@example.com", name: "Member", passwordHash: "x" },
      });
      const membership = await prisma.membership.create({
        data: { userId: member.id, organizationId: mockContext.organization.id, role: "ANALYST" },
      });

      await expect(
        changeMemberRole("org-a", formData({ membershipId: membership.id, role: "ADMIN" }))
      ).rejects.toThrow();
    });
  });
});
