"use server";

import { prisma } from "@/server/db/client";
import { Prisma } from "@/generated/prisma/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { maskPhoneNumber } from "@/lib/phone";
import { OutboundCallError, placeOutboundCall } from "@/server/telephony/outbound";
import { recordOptOut } from "@/server/telephony/optOut";
import {
  optOutSchema,
  outboundCallSchema,
  phoneNumberSettingsSchema,
  registerPhoneNumberSchema,
  REMOVE_OPT_OUT_CONFIRMATION,
} from "@/lib/validation/phone";

export type PhoneActionResult = { ok: true; message: string } | { ok: false; error: string };

function firstIssue(error: { issues: Array<{ message: string }> }, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

/** Which agent answers, the human transfer line, and the direction switches. Owner/Admin only. */
export async function updatePhoneNumberSettings(
  organizationSlug: string,
  phoneNumberId: string,
  formData: FormData
): Promise<PhoneActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const parsed = phoneNumberSettingsSchema.safeParse({
    agentId: formData.get("agentId") ?? "",
    transferNumber: formData.get("transferNumber") ?? "",
    inboundEnabled: formData.get("inboundEnabled"),
    outboundEnabled: formData.get("outboundEnabled"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error, "Invalid settings.") };
  }
  const number = await prisma.phoneNumber.findFirst({
    where: { id: phoneNumberId, organizationId: context.organization.id },
  });
  if (!number) {
    return { ok: false, error: "Phone number not found." };
  }
  if (parsed.data.agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: parsed.data.agentId, organizationId: context.organization.id, archivedAt: null },
      select: { publishedVersionId: true },
    });
    if (!agent) {
      return { ok: false, error: "Agent not found." };
    }
    if (!agent.publishedVersionId) {
      return { ok: false, error: "Publish the agent before it can answer calls." };
    }
  }
  if (parsed.data.transferNumber === number.e164) {
    return { ok: false, error: "The transfer line can't be this same number." };
  }

  await prisma.$transaction([
    prisma.phoneNumber.update({ where: { id: number.id }, data: parsed.data }),
    prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "phone.number_updated",
        metadata: {
          phoneNumberId: number.id,
          agentId: parsed.data.agentId,
          transferNumber: parsed.data.transferNumber ? maskPhoneNumber(parsed.data.transferNumber) : null,
          inboundEnabled: parsed.data.inboundEnabled,
          outboundEnabled: parsed.data.outboundEnabled,
        },
      },
    }),
  ]);
  return { ok: true, message: "Phone settings saved." };
}

/** One authorized AI call. Agent Manager and above; every other rule is enforced in placeOutboundCall. */
export async function startOutboundCall(organizationSlug: string, formData: FormData): Promise<PhoneActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = outboundCallSchema.safeParse({
    phoneNumberId: formData.get("phoneNumberId") ?? "",
    leadId: formData.get("leadId") ?? "",
    destination: formData.get("destination") ?? "",
    requestConfirmed: formData.get("requestConfirmed"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error, "Invalid call request.") };
  }

  let destination = parsed.data.destination;
  if (parsed.data.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: parsed.data.leadId, organizationId: context.organization.id },
      select: { phone: true },
    });
    if (!lead?.phone) {
      return { ok: false, error: "That lead has no phone number." };
    }
    destination = lead.phone;
  }

  try {
    await placeOutboundCall({
      organizationId: context.organization.id,
      userId: context.user.id,
      phoneNumberId: parsed.data.phoneNumberId,
      destination,
      leadId: parsed.data.leadId,
      requestConfirmed: parsed.data.requestConfirmed,
    });
  } catch (error) {
    if (error instanceof OutboundCallError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  return { ok: true, message: "Calling now. The call will appear in Recent calls." };
}

/** Anyone who manages agents can add a number to the do-not-call list; adding is always safe. */
export async function addOptOut(organizationSlug: string, formData: FormData): Promise<PhoneActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = optOutSchema.safeParse({ phoneNumber: formData.get("phoneNumber") ?? "" });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error, "Invalid phone number.") };
  }
  const created = await recordOptOut(prisma, {
    organizationId: context.organization.id,
    phoneNumber: parsed.data.phoneNumber,
    source: "STAFF",
    createdByUserId: context.user.id,
  });
  if (created) {
    await prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "phone.opt_out_added",
        metadata: { phoneNumber: maskPhoneNumber(parsed.data.phoneNumber) },
      },
    });
  }
  return { ok: true, message: created ? "Added to the do-not-call list." : "That number is already on the list." };
}

/**
 * Owner only, with a typed confirmation: removing someone lets the business call them again, which
 * should only happen when the person asks.
 */
export async function removeOptOut(
  organizationSlug: string,
  optOutId: string,
  formData: FormData
): Promise<PhoneActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER"]);

  if (String(formData.get("confirmation") ?? "").trim() !== REMOVE_OPT_OUT_CONFIRMATION) {
    return { ok: false, error: `Type ${REMOVE_OPT_OUT_CONFIRMATION} to confirm the person asked to be called again.` };
  }
  const entry = await prisma.callOptOut.findFirst({
    where: { id: optOutId, organizationId: context.organization.id },
  });
  if (!entry) {
    return { ok: false, error: "Entry not found." };
  }
  await prisma.$transaction([
    prisma.callOptOut.delete({ where: { id: entry.id } }),
    prisma.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "phone.opt_out_removed",
        metadata: { phoneNumber: maskPhoneNumber(entry.phoneNumber), source: entry.source },
      },
    }),
  ]);
  return { ok: true, message: "Removed from the do-not-call list." };
}

/**
 * Platform admin: records a number already bought and verified in Twilio (Ghana numbers need business
 * KYC there) and assigns it to an organization. Its voice URL and status callback are set in Twilio.
 */
export async function registerPhoneNumber(formData: FormData): Promise<PhoneActionResult> {
  const admin = await requirePlatformAdmin();
  const parsed = registerPhoneNumberSchema.safeParse({
    e164: formData.get("e164") ?? "",
    providerNumberSid: formData.get("providerNumberSid") ?? "",
    organizationSlug: formData.get("organizationSlug") ?? "",
    label: formData.get("label") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error, "Invalid phone number.") };
  }
  const organization = await prisma.organization.findUnique({ where: { slug: parsed.data.organizationSlug } });
  if (!organization) {
    return { ok: false, error: "Organization not found." };
  }
  try {
    await prisma.$transaction([
      prisma.phoneNumber.create({
        data: {
          organizationId: organization.id,
          e164: parsed.data.e164,
          providerNumberSid: parsed.data.providerNumberSid,
          label: parsed.data.label,
        },
      }),
      prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          actorUserId: admin.id,
          action: "admin.phone_number_registered",
          metadata: { e164: parsed.data.e164 },
        },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "That number (or SID) is already registered." };
    }
    throw error;
  }
  return { ok: true, message: `${parsed.data.e164} assigned to ${organization.name}.` };
}

/** Platform admin: releases a number. Past calls keep their records (the link to the number is cleared). */
export async function releasePhoneNumber(phoneNumberId: string): Promise<PhoneActionResult> {
  const admin = await requirePlatformAdmin();
  const number = await prisma.phoneNumber.findUnique({ where: { id: phoneNumberId } });
  if (!number) {
    return { ok: false, error: "Phone number not found." };
  }
  await prisma.$transaction([
    prisma.phoneNumber.delete({ where: { id: number.id } }),
    prisma.auditLog.create({
      data: {
        organizationId: number.organizationId,
        actorUserId: admin.id,
        action: "admin.phone_number_released",
        metadata: { e164: number.e164 },
      },
    }),
  ]);
  return { ok: true, message: `${number.e164} released.` };
}
