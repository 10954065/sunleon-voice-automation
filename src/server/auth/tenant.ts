import "server-only";

import { prisma } from "@/server/db/client";
import type { Role } from "@/generated/prisma/client";

export class TenantAccessError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

/**
 * Pure Prisma lookup with no Next.js/next-auth dependency, so it can be unit- and
 * integration-tested directly without pulling in the whole Auth.js runtime.
 * The organization slug comes from the URL, but authorization never trusts it directly —
 * a Membership row for THIS user must exist for it to be returned.
 */
export async function resolveMembership(userId: string, organizationSlug: string) {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organization: { slug: organizationSlug },
    },
    include: { organization: true },
  });

  if (!membership) {
    throw new TenantAccessError("You do not have access to this organization.", 403);
  }

  return {
    organization: membership.organization,
    role: membership.role,
    membershipId: membership.id,
  };
}

const ROLE_RANK: Record<Role, number> = {
  ANALYST: 0,
  AGENT_MANAGER: 1,
  ADMIN: 2,
  OWNER: 3,
  SUPER_ADMIN: 4,
};

export function requireRole(currentRole: Role, allowed: Role[]) {
  const isAllowed = allowed.some((role) => ROLE_RANK[currentRole] >= ROLE_RANK[role]);
  if (!isAllowed) {
    throw new TenantAccessError(
      `This action requires one of: ${allowed.join(", ")}.`,
      403
    );
  }
}
