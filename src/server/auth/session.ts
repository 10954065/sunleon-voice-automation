import "server-only";

import { auth } from "@/server/auth/config";
import { resolveMembership, TenantAccessError } from "@/server/auth/tenant";

export async function getCurrentUser() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }
  return session.user;
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new TenantAccessError("You must be signed in.", 401);
  }
  return user;
}

/** Resolves tenant context for the signed-in user from their own Membership row. */
export async function requireOrgContext(organizationSlug: string) {
  const user = await requireCurrentUser();
  const membership = await resolveMembership(user.id, organizationSlug);
  return { user, ...membership };
}
