import "server-only";

import { prisma } from "@/server/db/client";
import { requireCurrentUser } from "@/server/auth/session";
import { TenantAccessError } from "@/server/auth/tenant";

/**
 * Cross-tenant operator access. Checked against the database on every call (not the session
 * token), so revoking the flag takes effect immediately. There is deliberately no UI to grant it.
 */
export async function requirePlatformAdmin() {
  const user = await requireCurrentUser();
  const record = await prisma.user.findUnique({ where: { id: user.id }, select: { isPlatformAdmin: true } });
  if (!record?.isPlatformAdmin) {
    throw new TenantAccessError("Platform administrators only.", 403);
  }
  return user;
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const record = await prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
  return record?.isPlatformAdmin ?? false;
}
