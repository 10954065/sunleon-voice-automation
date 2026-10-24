import "server-only";

import { prisma } from "@/server/db/client";
import { scrubSensitiveText } from "@/server/observability/errors";
import { getPublicBaseUrl, telephonyWebhookUrl } from "./config";
import { settlePhoneConversation } from "./session";
import { getTelephonyCarrier, type TelephonyCarrier } from "./twilio";
import { SPOKEN, transferTwiml } from "./twiml";

export type TransferResult = { ok: true } | { ok: false; error: string };

/**
 * Hands a live call to the business's human line by replacing the call's TwiML through Twilio's
 * API, which drops the AI leg. The AI usage stops at that moment, so the conversation settles here
 * (outcome TRANSFERRED); whether the person answered arrives later at the transfer-result webhook.
 */
export async function requestTransfer(params: {
  conversationId: string;
  carrier?: TelephonyCarrier;
  now?: Date;
}): Promise<TransferResult> {
  const now = params.now ?? new Date();
  const phoneCall = await prisma.phoneCall.findUnique({
    where: { conversationId: params.conversationId },
    include: { phoneNumber: true, conversation: { select: { status: true, agentId: true } } },
  });
  const transferNumber = phoneCall?.phoneNumber?.transferNumber;
  if (!phoneCall || !phoneCall.phoneNumber || !transferNumber) {
    return { ok: false, error: "No transfer line is set up for this number." };
  }
  if (phoneCall.conversation.status !== "ACTIVE" || !phoneCall.providerCallSid) {
    return { ok: false, error: "This call is no longer active." };
  }
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    return { ok: false, error: "Transfers aren't available right now." };
  }

  // Claim first, so a repeated tool call can't redirect the call twice.
  const claimed = await prisma.phoneCall.updateMany({
    where: { id: phoneCall.id, transferStatus: null },
    data: { transferStatus: "REQUESTED", transferRequestedAt: now },
  });
  if (claimed.count !== 1) {
    return { ok: false, error: "A transfer is already in progress." };
  }

  try {
    await (params.carrier ?? getTelephonyCarrier()).redirectCall(
      phoneCall.providerCallSid,
      transferTwiml({
        transferNumber,
        // The team sees who is calling; falls back to the business's own number for withheld callers.
        callerId: phoneCall.remoteNumber ?? phoneCall.phoneNumber.e164,
        actionUrl: telephonyWebhookUrl(baseUrl, "twilio/transfer-result", { conversation: params.conversationId }),
        announce: SPOKEN.connectingTransfer,
      })
    );
  } catch (error) {
    await prisma.phoneCall.update({
      where: { id: phoneCall.id },
      data: { transferStatus: null, transferRequestedAt: null },
    });
    await prisma.usageEvent.create({
      data: {
        organizationId: phoneCall.organizationId,
        agentId: phoneCall.conversation.agentId,
        conversationId: params.conversationId,
        type: "ERROR",
        metadata: { stage: "transfer", message: scrubSensitiveText(error instanceof Error ? error.message : "unknown").slice(0, 300) },
      },
    });
    return { ok: false, error: "The transfer didn't go through. Offer to take a message instead." };
  }

  await settlePhoneConversation(params.conversationId, {
    reason: "transferred",
    source: "server_clock",
    now,
    transferred: true,
  });
  return { ok: true };
}
