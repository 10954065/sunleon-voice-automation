"use server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { leadStatusSchema } from "@/lib/validation/privacy";

export type LeadActionResult = { ok: true } | { ok: false; error: string };

/** Follow-up tracking. Analysts are read-only, so changing status needs Agent Manager or above. */
export async function updateLeadStatus(organizationSlug: string, leadId: string, status: string): Promise<LeadActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["AGENT_MANAGER"]);

  const parsed = leadStatusSchema.safeParse(status);
  if (!parsed.success) {
    return { ok: false, error: "Unknown status." };
  }
  const updated = await prisma.lead.updateMany({
    where: { id: leadId, organizationId: context.organization.id },
    data: { status: parsed.data, statusChangedAt: new Date() },
  });
  return updated.count === 1 ? { ok: true } : { ok: false, error: "Lead not found." };
}

/** Deletes one lead. The audit entry keeps the id only, never the contact details being removed. */
export async function deleteLead(organizationSlug: string, leadId: string): Promise<LeadActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.lead.deleteMany({ where: { id: leadId, organizationId: context.organization.id } });
    if (result.count > 0) {
      await tx.auditLog.create({
        data: {
          organizationId: context.organization.id,
          actorUserId: context.user.id,
          action: "lead.deleted",
          metadata: { leadId },
        },
      });
    }
    return result.count;
  });
  return deleted === 1 ? { ok: true } : { ok: false, error: "Lead not found." };
}
