import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resolveMembership, requireRole, TenantAccessError } from "@/server/auth/tenant";
import { resetDatabase } from "./helpers";

async function createOrgWithOwner(orgName: string, orgSlug: string, ownerEmail: string) {
  const user = await prisma.user.create({
    data: { email: ownerEmail, name: ownerEmail, passwordHash: "irrelevant-for-this-test" },
  });
  const organization = await prisma.organization.create({
    data: { name: orgName, slug: orgSlug },
  });
  await prisma.membership.create({
    data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
  });
  return { user, organization };
}

describe("tenant isolation", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("resolves membership for a user who belongs to the organization", async () => {
    const { user, organization } = await createOrgWithOwner("Org A", "org-a", "owner-a@example.com");

    const result = await resolveMembership(user.id, organization.slug);

    expect(result.organization.id).toBe(organization.id);
    expect(result.role).toBe("OWNER");
  });

  it("refuses to resolve membership for a user with no row in that organization", async () => {
    const { user: userA } = await createOrgWithOwner("Org A", "org-a", "owner-a@example.com");
    const { organization: orgB } = await createOrgWithOwner("Org B", "org-b", "owner-b@example.com");

    await expect(resolveMembership(userA.id, orgB.slug)).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("a member of Org A cannot read Org B's data even by supplying Org B's slug directly", async () => {
    const { user: userA } = await createOrgWithOwner("Org A", "org-a", "owner-a@example.com");
    const { organization: orgB } = await createOrgWithOwner("Org B", "org-b", "owner-b@example.com");

    // Simulates a malicious/mistaken request where userA's session is real,
    // but the org slug in the URL belongs to a different tenant.
    await expect(resolveMembership(userA.id, orgB.slug)).rejects.toThrow(
      "You do not have access to this organization."
    );

    const orgBMembers = await prisma.membership.findMany({
      where: { organizationId: orgB.id },
    });
    expect(orgBMembers.map((m) => m.userId)).not.toContain(userA.id);
  });

  it("an ANALYST in their own org cannot perform an OWNER-only action", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Org C", slug: "org-c" },
    });
    const analystUser = await prisma.user.create({
      data: { email: "analyst@example.com", passwordHash: "x" },
    });
    await prisma.membership.create({
      data: { userId: analystUser.id, organizationId: organization.id, role: "ANALYST" },
    });

    const { role } = await resolveMembership(analystUser.id, organization.slug);
    expect(() => requireRole(role, ["OWNER"])).toThrow(TenantAccessError);
  });
});
