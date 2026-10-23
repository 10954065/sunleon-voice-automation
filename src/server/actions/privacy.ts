"use server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { eraseContactData, MIN_PHONE_DIGITS, normalizePhoneDigits } from "@/server/privacy/erasure";
import { conversationIdSchema } from "@/lib/validation/voice";
import { DELETE_ALL_CONFIRMATION, dataSettingsSchema, eraseContactSchema } from "@/lib/validation/privacy";

export type PrivacyActionResult = { ok: true; message: string } | { ok: false; error: string };

/** Transcript storage and retention windows. Owner-only: it decides what personal data the business keeps. */
export async function updateDataSettings(organizationSlug: string, formData: FormData): Promise<PrivacyActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  const parsed = dataSettingsSchema.safeParse({
    storeTranscripts: formData.get("storeTranscripts"),
    transcriptRetentionDays: formData.get("transcriptRetentionDays"),
    leadRetentionDays: formData.get("leadRetentionDays"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings." };
  }

  await prisma.$transaction([
    prisma.organization.update({ where: { id: context.organization.id }, data: parsed.data }),
    prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "privacy.settings_updated",
        metadata: parsed.data,
      },
    }),
  ]);
  return { ok: true, message: "Data settings saved. Retention applies from the next daily clean-up." };
}

export async function deleteConversationTranscript(
  organizationSlug: string,
  conversationId: string
): Promise<PrivacyActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const id = conversationIdSchema.safeParse(conversationId);
  if (!id.success) {
    return { ok: false, error: "Invalid conversation." };
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.conversationTranscript.deleteMany({
      where: { conversationId: id.data, organizationId: context.organization.id },
    });
    if (result.count > 0) {
      await tx.auditLog.create({
        data: {
          organizationId: context.organization.id,
          actorUserId: context.user.id,
          action: "privacy.transcript_deleted",
          metadata: { conversationId: id.data },
        },
      });
    }
    return result.count;
  });
  return deleted > 0
    ? { ok: true, message: "Transcript and summary deleted." }
    : { ok: false, error: "There's no stored transcript for this conversation." };
}

export async function deleteAllTranscripts(organizationSlug: string, formData: FormData): Promise<PrivacyActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  if (String(formData.get("confirmation") ?? "").trim() !== DELETE_ALL_CONFIRMATION) {
    return { ok: false, error: `Type ${DELETE_ALL_CONFIRMATION} to confirm.` };
  }

  const count = await prisma.$transaction(async (tx) => {
    const result = await tx.conversationTranscript.deleteMany({ where: { organizationId: context.organization.id } });
    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "privacy.all_transcripts_deleted",
        metadata: { count: result.count },
      },
    });
    return result.count;
  });
  return { ok: true, message: `Deleted ${count} stored transcript${count === 1 ? "" : "s"}.` };
}

/**
 * A visitor asked for their data to be deleted. The audit entry records only counts — writing the
 * email or phone number into the log would keep the very data being erased.
 */
export async function eraseContact(organizationSlug: string, formData: FormData): Promise<PrivacyActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const parsed = eraseContactSchema.safeParse({
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  if (parsed.data.phone && !normalizePhoneDigits(parsed.data.phone)) {
    return { ok: false, error: `Enter at least ${MIN_PHONE_DIGITS} digits of the phone number.` };
  }

  const result = await eraseContactData({
    organizationId: context.organization.id,
    email: parsed.data.email,
    phone: parsed.data.phone,
  });
  await prisma.auditLog.create({
    data: {
      organizationId: context.organization.id,
      actorUserId: context.user.id,
      action: "privacy.contact_erased",
      metadata: {
        matchedBy: [parsed.data.email ? "email" : null, parsed.data.phone ? "phone" : null].filter(Boolean),
        leadsDeleted: result.leadsDeleted,
        transcriptsDeleted: result.transcriptsDeleted,
      },
    },
  });
  return {
    ok: true,
    message: `Deleted ${result.leadsDeleted} lead${result.leadsDeleted === 1 ? "" : "s"} and ${result.transcriptsDeleted} transcript${result.transcriptsDeleted === 1 ? "" : "s"}.`,
  };
}
