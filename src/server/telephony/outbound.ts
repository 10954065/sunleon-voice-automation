import "server-only";

import { prisma } from "@/server/db/client";
import { maskPhoneNumber, toE164 } from "@/lib/phone";
import { QuotaExceededError } from "@/server/billing/quota";
import { scrubSensitiveText } from "@/server/observability/errors";
import {
  CALLING_HOURS_UTC,
  getOutboundCallingCodes,
  getPublicBaseUrl,
  getRealtimeSipConfig,
  getTwilioCredentials,
  OUTBOUND_CALLS_PER_HOUR,
  OUTBOUND_REPEAT_COOLDOWN_MS,
  OUTBOUND_RING_TIMEOUT_SECONDS,
  telephonyWebhookUrl,
} from "./config";
import { isOptedOut } from "./optOut";
import { createPhoneConversation, PHONE_RESERVATION_TX_OPTIONS } from "./session";
import { getTelephonyCarrier, type TelephonyCarrier } from "./twilio";

/** Seconds added to Twilio's time limit for the announcement and keypad step before the AI joins. */
const ANNOUNCEMENT_ALLOWANCE_SECONDS = 60;

export class OutboundCallError extends Error {}

export function isWithinCallingHours(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= CALLING_HOURS_UTC.startHour && hour < CALLING_HOURS_UTC.endHour;
}

export function isAllowedDestination(e164: string, callingCodes: string[]): boolean {
  return callingCodes.some((code) => e164.startsWith(`+${code}`));
}

/**
 * Places one AI call on behalf of a business. Authorized means all of:
 * - a staff member with Agent Manager rights asked for it (checked by the caller of this function);
 * - the number is assigned to the organization, outbound is on, and its agent is published;
 * - the person asked to be contacted: either they left this number as a lead with this business,
 *   or the staff member confirms they asked for a call (recorded in the audit log);
 * - the number isn't on the do-not-call list, is in an allowed country, and it's 08:00–20:00 in Ghana;
 * - the organization is under its hourly outbound limit and hasn't called this number in 10 minutes;
 * - the plan's allowance covers it (the same reservation as any session).
 * One call per request — there is no bulk or list dialling.
 */
export async function placeOutboundCall(params: {
  organizationId: string;
  userId: string;
  phoneNumberId: string;
  destination: string;
  leadId?: string;
  requestConfirmed: boolean;
  carrier?: TelephonyCarrier;
  now?: Date;
}): Promise<{ conversationId: string }> {
  const now = params.now ?? new Date();
  const baseUrl = getPublicBaseUrl();
  if (!getTwilioCredentials() || !getRealtimeSipConfig() || !baseUrl) {
    throw new OutboundCallError(
      "Phone calling isn't configured yet (Twilio and OpenAI credentials are missing). See the Phone page for details."
    );
  }

  const number = await prisma.phoneNumber.findFirst({
    where: { id: params.phoneNumberId, organizationId: params.organizationId },
    include: { agent: { include: { publishedVersion: true } } },
  });
  if (!number) {
    throw new OutboundCallError("Phone number not found.");
  }
  if (!number.outboundEnabled) {
    throw new OutboundCallError("Outbound calls are turned off for this number.");
  }
  const agent = number.agent;
  if (!agent || agent.archivedAt || !agent.publishedVersion) {
    throw new OutboundCallError("Assign a published agent to this number first.");
  }

  const destination = toE164(params.destination);
  if (!destination) {
    throw new OutboundCallError("Enter a valid phone number.");
  }
  if (!isAllowedDestination(destination, getOutboundCallingCodes())) {
    throw new OutboundCallError("Calls to that country aren't enabled.");
  }
  if (destination === number.e164) {
    throw new OutboundCallError("A number can't call itself.");
  }

  let basis: "lead" | "confirmed_request";
  if (params.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: params.leadId, organizationId: params.organizationId },
      select: { phone: true },
    });
    if (!lead || !lead.phone || toE164(lead.phone) !== destination) {
      throw new OutboundCallError("That lead doesn't have this phone number.");
    }
    basis = "lead";
  } else if (params.requestConfirmed) {
    basis = "confirmed_request";
  } else {
    throw new OutboundCallError("Confirm that this person asked to be called.");
  }

  if (!isWithinCallingHours(now)) {
    throw new OutboundCallError("Calls can only be placed between 08:00 and 20:00 Ghana time.");
  }

  let conversationId: string;
  let reservedSeconds: number;
  try {
    ({ conversationId, reservedSeconds } = await prisma.$transaction(async (tx) => {
      // createPhoneConversation takes the organization's lock first, so these checks and the
      // new call can't interleave with another staff member placing a call at the same moment.
      const created = await createPhoneConversation(tx, {
        organizationId: params.organizationId,
        agentId: agent.id,
        agentVersionId: agent.publishedVersion!.id,
        phoneNumberId: number.id,
        direction: "OUTBOUND",
        remoteNumber: destination,
        providerCallSid: null,
        providerStatus: "queued",
        requestedByUserId: params.userId,
        now,
      });
      if (await isOptedOut(tx, params.organizationId, destination)) {
        throw new OutboundCallError("This number is on your do-not-call list.");
      }
      const lastHour = await tx.phoneCall.count({
        where: {
          organizationId: params.organizationId,
          direction: "OUTBOUND",
          createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
          id: { not: created.phoneCall.id },
        },
      });
      if (lastHour >= OUTBOUND_CALLS_PER_HOUR) {
        throw new OutboundCallError(`Your organization can place at most ${OUTBOUND_CALLS_PER_HOUR} calls an hour.`);
      }
      const recent = await tx.phoneCall.count({
        where: {
          organizationId: params.organizationId,
          direction: "OUTBOUND",
          remoteNumber: destination,
          createdAt: { gte: new Date(now.getTime() - OUTBOUND_REPEAT_COOLDOWN_MS) },
          id: { not: created.phoneCall.id },
        },
      });
      if (recent > 0) {
        throw new OutboundCallError("This number was called in the last 10 minutes. Try again later.");
      }
      await tx.auditLog.create({
        data: {
          organizationId: params.organizationId,
          actorUserId: params.userId,
          action: "phone.outbound_call_placed",
          metadata: {
            conversationId: created.conversation.id,
            phoneNumberId: number.id,
            destination: maskPhoneNumber(destination),
            basis,
            ...(params.leadId && { leadId: params.leadId }),
          },
        },
      });
      return { conversationId: created.conversation.id, reservedSeconds: created.conversation.reservedSeconds };
    }, PHONE_RESERVATION_TX_OPTIONS));
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      throw new OutboundCallError(error.message);
    }
    throw error;
  }

  try {
    const { callSid } = await (params.carrier ?? getTelephonyCarrier()).createCall({
      to: destination,
      from: number.e164,
      answerUrl: telephonyWebhookUrl(baseUrl, "twilio/outbound-answer", { conversation: conversationId }),
      statusCallbackUrl: telephonyWebhookUrl(baseUrl, "twilio/status"),
      ringTimeoutSeconds: OUTBOUND_RING_TIMEOUT_SECONDS,
      timeLimitSeconds: reservedSeconds + ANNOUNCEMENT_ALLOWANCE_SECONDS,
    });
    await prisma.phoneCall.updateMany({
      where: { conversationId, providerCallSid: null },
      data: { providerCallSid: callSid },
    });
  } catch (error) {
    const message = scrubSensitiveText(error instanceof Error ? error.message : "The carrier refused the call.").slice(0, 300);
    await prisma.$transaction([
      prisma.conversation.updateMany({
        where: { id: conversationId, status: "ACTIVE" },
        data: { status: "FAILED", outcome: "FAILED", endedAt: now, closeReason: "carrier_create_failed", errorMessage: message },
      }),
      prisma.phoneCall.updateMany({
        where: { conversationId },
        data: { providerStatus: "failed", failureReason: "carrier_create_failed", endedAt: now },
      }),
    ]);
    throw new OutboundCallError("The call couldn't be placed. Please try again in a moment.");
  }

  return { conversationId };
}
