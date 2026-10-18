"use server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { inviteMemberSchema, changeRoleSchema } from "@/lib/validation/organization";

export type MembershipActionResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Adds an existing registered user to an organization by email.
 * Real invitation emails are not sent yet (no email provider configured) —
 * this only works if the invitee already has an account. Documented in
 * docs/KNOWN_LIMITATIONS.md.
 */
export async function inviteMember(
  organizationSlug: string,
  formData: FormData
): Promise<MembershipActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const parsed = inviteMemberSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const invitee = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!invitee) {
    return {
      ok: false,
      error: "No account exists for that email yet. They must register first.",
    };
  }

  const alreadyMember = await prisma.membership.findFirst({
    where: { userId: invitee.id, organizationId: context.organization.id },
  });
  if (alreadyMember) {
    return { ok: false, error: "This person is already a member." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.create({
      data: {
        userId: invitee.id,
        organizationId: context.organization.id,
        role: parsed.data.role,
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "member.invited",
        metadata: { invitedEmail: parsed.data.email, role: parsed.data.role },
      },
    });
  });

  return { ok: true };
}

export async function changeMemberRole(
  organizationSlug: string,
  formData: FormData
): Promise<MembershipActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  const parsed = changeRoleSchema.safeParse({
    membershipId: formData.get("membershipId"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const target = await prisma.membership.findFirst({
    where: { id: parsed.data.membershipId, organizationId: context.organization.id },
  });

  if (!target) {
    return { ok: false, error: "Member not found in this organization." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: target.id },
      data: { role: parsed.data.role },
    });

    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "member.role_changed",
        metadata: { membershipId: target.id, newRole: parsed.data.role },
      },
    });
  });

  return { ok: true };
}
