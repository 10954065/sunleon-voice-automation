import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/server/db/client";
import { reserveVoiceSeconds } from "@/server/billing/quota";
import { settleConversation, type UsageSource } from "@/server/billing/usage";
import { buildSessionInstructions } from "@/server/voice/instructions";
import { getKnowledgeSummary } from "@/server/voice/knowledgeContext";
import { MAX_PHONE_SESSION_SECONDS, REALTIME_SIP_MODEL, SIP_VOICE_PROVIDER_ID } from "./config";
import { PHONE_TOOL, phoneToolsFor } from "./toolDefinitions";
import type { RealtimeSessionForCall } from "./realtimeSip";
import type { CallDirection, Prisma } from "@/generated/prisma/client";

/** The reservation transaction may queue behind other sessions for the same organization. */
export const PHONE_RESERVATION_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

/**
 * Reserves allowance (capped at MAX_PHONE_SESSION_SECONDS) and creates the conversation and its
 * phone call together. Must run inside a transaction: QuotaExceededError rolls both back.
 */
export async function createPhoneConversation(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    agentId: string;
    agentVersionId: string;
    phoneNumberId: string;
    direction: CallDirection;
    remoteNumber: string | null;
    providerCallSid: string | null;
    providerStatus: string;
    requestedByUserId?: string;
    now: Date;
  }
) {
  const reservedSeconds = await reserveVoiceSeconds(tx, params.organizationId, params.now, MAX_PHONE_SESSION_SECONDS);
  const conversation = await tx.conversation.create({
    data: {
      // Unguessable: it travels in the SIP header and the webhook URLs as the call's reference.
      id: randomUUID(),
      organizationId: params.organizationId,
      agentId: params.agentId,
      agentVersionId: params.agentVersionId,
      channel: "PHONE",
      originDomain: null,
      startedAt: params.now,
      reservedSeconds,
    },
  });
  const phoneCall = await tx.phoneCall.create({
    data: {
      conversationId: conversation.id,
      organizationId: params.organizationId,
      phoneNumberId: params.phoneNumberId,
      direction: params.direction,
      remoteNumber: params.remoteNumber,
      providerCallSid: params.providerCallSid,
      providerStatus: params.providerStatus,
      requestedByUserId: params.requestedByUserId ?? null,
      // Same clock as the conversation, so the outbound rate limit and cooldown compare like with like.
      createdAt: params.now,
    },
  });
  return { conversation, phoneCall };
}

function phoneRules(params: { direction: CallDirection; transferAvailable: boolean; leadCapture: boolean }): string {
  return [
    "Phone call rules (platform rules, same precedence as above):",
    "You are speaking on a phone call. The caller has already been told this call is handled by an AI",
    "assistant; if anyone asks whether you are a person, say plainly that you are an AI assistant.",
    "Keep every reply short. Don't read personal details back in full.",
    params.direction === "OUTBOUND"
      ? "You placed this call on behalf of the business to follow up on the person's own request. Start by " +
        "saying who you are calling for and why, and ask whether now is a good time."
      : "Greet the caller and ask how you can help.",
    params.leadCapture
      ? `If the caller wants a follow-up, ask permission, then call ${PHONE_TOOL.saveContact}.`
      : "You can't take contact details on this line.",
    params.transferAvailable
      ? `If the caller asks for a person, or you can't help, offer to transfer them, then call ${PHONE_TOOL.transfer}.`
      : "No transfer to a person is available on this line; say so if asked.",
    `If the person says they don't want calls from the business, apologise, call ${PHONE_TOOL.optOut}, say goodbye and call ${PHONE_TOOL.endCall}.`,
    `When the conversation is finished, say goodbye, then call ${PHONE_TOOL.endCall}.`,
  ].join(" ");
}

/**
 * The AI session for a call, sent with the accept request — server to OpenAI, so the business's
 * instructions never pass through the caller's device (unlike the browser widget path).
 */
export async function buildPhoneSession(conversationId: string): Promise<RealtimeSessionForCall> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { agentVersion: true, organization: true, phoneCall: { include: { phoneNumber: true } } },
  });
  const knowledgeSummary = await getKnowledgeSummary({
    organizationId: conversation.organizationId,
    agentId: conversation.agentId,
  });
  const version = conversation.agentVersion;
  const transferAvailable = Boolean(conversation.phoneCall?.phoneNumber?.transferNumber);
  const instructions = [
    buildSessionInstructions({
      organizationName: conversation.organization.name,
      persona: version.persona,
      tone: version.tone,
      greeting: version.greeting,
      instructions: version.instructions,
      languages: version.languages,
      knowledgeSummary,
    }),
    phoneRules({
      direction: conversation.phoneCall?.direction ?? "INBOUND",
      transferAvailable,
      leadCapture: version.leadCaptureEnabled,
    }),
  ].join("\n\n");

  return {
    model: REALTIME_SIP_MODEL,
    instructions,
    audio: { output: { voice: version.voice } },
    tools: phoneToolsFor({ leadCapture: version.leadCaptureEnabled, transferAvailable }),
    tool_choice: "auto",
  };
}

/**
 * Settles a phone conversation once (see settleConversation). chargedSeconds defaults to our own
 * clock since the AI leg was accepted; either way the charge never exceeds the reservation.
 */
export async function settlePhoneConversation(
  conversationId: string,
  params: {
    reason: string;
    source: UsageSource;
    now: Date;
    chargedSeconds?: number;
    failed?: boolean;
    transferred?: boolean;
  }
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.status !== "ACTIVE") {
      return false;
    }
    const measured = conversation.tokenIssuedAt
      ? Math.max(0, Math.round((params.now.getTime() - conversation.tokenIssuedAt.getTime()) / 1000))
      : 0;
    const raw = Math.max(0, Math.round(params.chargedSeconds ?? measured));
    const cap = conversation.reservedSeconds > 0 ? conversation.reservedSeconds : MAX_PHONE_SESSION_SECONDS;
    const charged = Math.min(raw, cap);
    return settleConversation(tx, {
      conversation,
      reason: params.reason,
      chargedSeconds: charged,
      source: params.source,
      now: params.now,
      failed: params.failed,
      transferred: params.transferred,
      provider: SIP_VOICE_PROVIDER_ID,
      model: REALTIME_SIP_MODEL,
      ...(charged !== raw && { measuredSeconds: raw }),
    });
  });
}
