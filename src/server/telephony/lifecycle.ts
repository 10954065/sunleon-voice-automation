import "server-only";

import { prisma } from "@/server/db/client";
import { Prisma } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { QuotaExceededError } from "@/server/billing/quota";
import { recordCarrierUsage } from "@/server/billing/usage";
import { reportError, scrubSensitiveText } from "@/server/observability/errors";
import {
  AI_ACCEPT_WINDOW_MS,
  CARRIER_PROVIDER_ID,
  getPublicBaseUrl,
  getRealtimeSipConfig,
  realtimeSipUri,
  telephonyWebhookUrl,
} from "./config";
import { recordOptOut } from "./optOut";
import { getRealtimeCallControl, type IncomingRealtimeCall, type RealtimeCallControl } from "./realtimeSip";
import { buildPhoneSession, createPhoneConversation, PHONE_RESERVATION_TX_OPTIONS, settlePhoneConversation } from "./session";
import {
  connectAiTwiml,
  hangUpTwiml,
  inboundAnswerTwiml,
  OPT_OUT_DIGIT,
  outboundAnswerTwiml,
  sayAndHangUpTwiml,
  SPOKEN,
  transferTwiml,
} from "./twiml";
import type { TelephonyWebhookSource, WebhookEventStatus } from "@/generated/prisma/client";

/** Twilio webhook parameters (form fields), after the signature has been verified. */
export type TwilioForm = Record<string, string>;

/** Twilio CallStatus values in the order a call moves through them; the last rank is terminal. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  initiated: 1,
  ringing: 2,
  "in-progress": 3,
  completed: 4,
  busy: 4,
  failed: 4,
  "no-answer": 4,
  canceled: 4,
};
const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

/**
 * Status callbacks can arrive late, twice, or out of order. A status is applied only if it moves the
 * call forward, and nothing moves a call out of a terminal status.
 */
export function shouldApplyStatus(current: string, next: string): boolean {
  const nextRank = STATUS_RANK[next];
  if (nextRank === undefined || TERMINAL_STATUSES.has(current)) {
    return false;
  }
  return nextRank >= (STATUS_RANK[current] ?? 0);
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function parseSeconds(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function isAnsweringMachine(answeredBy: string | undefined): boolean {
  return Boolean(answeredBy && /^(machine|fax)/.test(answeredBy));
}

async function logEvent(params: {
  source: TelephonyWebhookSource;
  eventKey: string;
  eventType: string;
  status: WebhookEventStatus;
  organizationId?: string | null;
  note?: string;
}): Promise<boolean> {
  const created = await prisma.telephonyWebhookEvent.createMany({
    data: [
      {
        source: params.source,
        eventKey: params.eventKey.slice(0, 200),
        eventType: params.eventType,
        status: params.status,
        organizationId: params.organizationId ?? null,
        note: params.note ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return created.count === 1;
}

async function seenEvent(source: TelephonyWebhookSource, eventKey: string): Promise<boolean> {
  const existing = await prisma.telephonyWebhookEvent.findUnique({
    where: { source_eventKey: { source, eventKey: eventKey.slice(0, 200) } },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * When the AI can't take a call: the business's human line if it set one, otherwise a short
 * apology. The fallback dial reports back to transfer-result with no conversation attached.
 */
function fallbackTwiml(params: {
  organizationName: string;
  transferNumber: string | null;
  callerId: string;
  baseUrl: string | null;
}): string {
  if (params.transferNumber && params.baseUrl) {
    return transferTwiml({
      transferNumber: params.transferNumber,
      callerId: params.callerId,
      actionUrl: telephonyWebhookUrl(params.baseUrl, "twilio/transfer-result"),
      announce: SPOKEN.connectingFallback,
    });
  }
  return sayAndHangUpTwiml(SPOKEN.unavailable(params.organizationName));
}

function aiDialTwiml(params: {
  conversationId: string;
  reservedSeconds: number;
  baseUrl: string;
  projectId: string;
  organizationName?: string;
}): string {
  const shared = {
    sipUri: realtimeSipUri(params.projectId, params.conversationId),
    dialActionUrl: telephonyWebhookUrl(params.baseUrl, "twilio/ai-dial-result", { conversation: params.conversationId }),
    timeLimitSeconds: params.reservedSeconds,
  };
  return params.organizationName
    ? inboundAnswerTwiml({ ...shared, organizationName: params.organizationName })
    : connectAiTwiml(shared);
}

// --- Inbound ---

/**
 * Twilio's voice webhook for one of our numbers. Organization and agent come from the number that
 * was called (a row a platform admin assigned), never from anything the caller controls. A retried
 * webhook for the same CallSid gets the same answer without reserving allowance twice.
 */
export async function handleInboundCall(form: TwilioForm, now: Date = new Date()): Promise<string> {
  const callSid = form.CallSid;
  const baseUrl = getPublicBaseUrl();
  const sip = getRealtimeSipConfig();

  const existing = await prisma.phoneCall.findUnique({
    where: { providerCallSid: callSid },
    include: { conversation: true, organization: true },
  });
  if (existing) {
    return existing.conversation.status === "ACTIVE" && !existing.conversation.tokenIssuedAt && sip && baseUrl
      ? aiDialTwiml({
          conversationId: existing.conversationId,
          reservedSeconds: existing.conversation.reservedSeconds,
          baseUrl,
          projectId: sip.projectId,
          organizationName: existing.organization.name,
        })
      : hangUpTwiml();
  }

  const calledNumber = toE164(form.To ?? "");
  const number = calledNumber
    ? await prisma.phoneNumber.findUnique({
        where: { e164: calledNumber },
        include: { organization: true, agent: { include: { publishedVersion: true } } },
      })
    : null;
  const eventKey = `${callSid}:voice`;
  if (!number) {
    await logEvent({ source: "TWILIO", eventKey, eventType: "voice", status: "IGNORED", note: "unknown_number" });
    return sayAndHangUpTwiml(SPOKEN.notInService);
  }

  // Withheld or non-phone callers have no usable number; the call is still answered.
  const remoteNumber = toE164(form.From ?? "");
  const fallback = (note: string) =>
    logEvent({ source: "TWILIO", eventKey, eventType: "voice", status: "IGNORED", organizationId: number.organizationId, note }).then(
      () =>
        fallbackTwiml({
          organizationName: number.organization.name,
          transferNumber: number.transferNumber,
          callerId: remoteNumber ?? number.e164,
          baseUrl,
        })
    );

  const agent = number.agent;
  if (!number.inboundEnabled || !agent || agent.archivedAt || !agent.publishedVersion) {
    return fallback("no_published_agent");
  }
  if (!sip || !baseUrl) {
    return fallback("ai_not_configured");
  }

  let created;
  try {
    created = await prisma.$transaction(
      (tx) =>
        createPhoneConversation(tx, {
          organizationId: number.organizationId,
          agentId: agent.id,
          agentVersionId: agent.publishedVersion!.id,
          phoneNumberId: number.id,
          direction: "INBOUND",
          remoteNumber,
          providerCallSid: callSid,
          providerStatus: form.CallStatus || "ringing",
          now,
        }),
      PHONE_RESERVATION_TX_OPTIONS
    );
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return fallback(`quota_${error.reason}`);
    }
    // Twilio retried while the first request was still running: answer from the row it created.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return handleInboundCall(form, now);
    }
    throw error;
  }

  await logEvent({ source: "TWILIO", eventKey, eventType: "voice", status: "PROCESSED", organizationId: number.organizationId });
  return aiDialTwiml({
    conversationId: created.conversation.id,
    reservedSeconds: created.conversation.reservedSeconds,
    baseUrl,
    projectId: sip.projectId,
    organizationName: number.organization.name,
  });
}

// --- AI leg (OpenAI Realtime SIP) ---

export type RealtimeIncomingResult =
  | { status: "accepted"; conversationId: string; callId: string; reservedSeconds: number }
  | { status: "duplicate" | "rejected" | "failed" };

/**
 * Atomic, single-use claim: only a PHONE conversation we set up, still active, never accepted, and
 * within the accept window. The conversation id in the SIP header is an unguessable reference, but
 * the header itself is untrusted, so a stray or replayed INVITE can't attach to anything else.
 */
async function claimAiLeg(conversationId: string, callId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.conversation.updateMany({
      where: {
        id: conversationId,
        channel: "PHONE",
        status: "ACTIVE",
        tokenIssuedAt: null,
        startedAt: { gte: new Date(now.getTime() - AI_ACCEPT_WINDOW_MS) },
      },
      data: { tokenIssuedAt: now },
    });
    if (claimed.count !== 1) {
      return false;
    }
    await tx.phoneCall.updateMany({
      where: { conversationId, realtimeCallId: null },
      data: { realtimeCallId: callId },
    });
    return true;
  });
}

export async function handleRealtimeIncoming(
  call: IncomingRealtimeCall,
  deps: { callControl?: RealtimeCallControl; now?: Date } = {}
): Promise<RealtimeIncomingResult> {
  const now = deps.now ?? new Date();
  const control = deps.callControl ?? getRealtimeCallControl();
  // OpenAI redelivers until it gets a 2xx; the same webhook-id, or a call we already accepted, is a no-op.
  // Rejecting here would hang up a live call.
  if (
    (await seenEvent("OPENAI", call.webhookId)) ||
    (await prisma.phoneCall.findUnique({ where: { realtimeCallId: call.callId }, select: { id: true } }))
  ) {
    return { status: "duplicate" };
  }

  const claimed = call.conversationId ? await claimAiLeg(call.conversationId, call.callId, now) : false;
  if (!claimed || !call.conversationId) {
    try {
      await control.reject(call.callId);
    } catch (error) {
      await reportError(error, { source: "route", route: "telephony:openai:reject" });
    }
    await logEvent({
      source: "OPENAI",
      eventKey: call.webhookId,
      eventType: "realtime.call.incoming",
      status: "IGNORED",
      note: "unmatched_call",
    });
    return { status: "rejected" };
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: call.conversationId } });
  try {
    await control.accept(call.callId, await buildPhoneSession(conversation.id));
  } catch (error) {
    const message = scrubSensitiveText(error instanceof Error ? error.message : "Unknown error accepting the call.").slice(0, 300);
    // Not settled through the ledger: the AI never answered, so there is nothing to bill. Twilio's
    // dial then fails and the caller gets the fallback (see handleAiDialResult).
    await prisma.$transaction([
      prisma.conversation.updateMany({
        where: { id: conversation.id, status: "ACTIVE" },
        data: { status: "FAILED", outcome: "FAILED", endedAt: now, closeReason: "ai_accept_failed", errorMessage: message },
      }),
      prisma.usageEvent.create({
        data: {
          organizationId: conversation.organizationId,
          agentId: conversation.agentId,
          conversationId: conversation.id,
          type: "ERROR",
          metadata: { stage: "sip_accept", message },
        },
      }),
    ]);
    await logEvent({
      source: "OPENAI",
      eventKey: call.webhookId,
      eventType: "realtime.call.incoming",
      status: "PROCESSED",
      organizationId: conversation.organizationId,
      note: "accept_failed",
    });
    await reportError(error, { source: "route", route: "telephony:openai:accept" });
    return { status: "failed" };
  }

  await prisma.usageEvent.create({
    data: {
      organizationId: conversation.organizationId,
      agentId: conversation.agentId,
      conversationId: conversation.id,
      type: "SESSION_STARTED",
      metadata: { channel: "PHONE" },
    },
  });
  await logEvent({
    source: "OPENAI",
    eventKey: call.webhookId,
    eventType: "realtime.call.incoming",
    status: "PROCESSED",
    organizationId: conversation.organizationId,
  });
  return {
    status: "accepted",
    conversationId: conversation.id,
    callId: call.callId,
    reservedSeconds: conversation.reservedSeconds,
  };
}

/** The call's carrier record, but only if the signed CallSid matches the conversation in the URL. */
async function findCallForCallback(conversationId: string, callSid: string | undefined) {
  if (!callSid) {
    return null;
  }
  const phoneCall = await prisma.phoneCall.findUnique({
    where: { conversationId },
    include: { conversation: true, organization: true, phoneNumber: true },
  });
  return phoneCall && phoneCall.providerCallSid === callSid ? phoneCall : null;
}

/**
 * Twilio's Dial action after the AI leg ends. A completed leg is billed on Twilio's measurement of
 * it (DialCallDuration); a leg that never connected fails the conversation and falls back.
 */
export async function handleAiDialResult(conversationId: string, form: TwilioForm, now: Date = new Date()): Promise<string> {
  const phoneCall = await findCallForCallback(conversationId, form.CallSid);
  if (!phoneCall) {
    return hangUpTwiml();
  }
  await logEvent({
    source: "TWILIO",
    eventKey: `${form.CallSid}:ai-dial-result`,
    eventType: "ai-dial-result",
    status: "PROCESSED",
    organizationId: phoneCall.organizationId,
  });
  const baseUrl = getPublicBaseUrl();

  // The call was redirected to a person while this leg ended; keep the caller on that path.
  if (phoneCall.transferStatus === "REQUESTED" && phoneCall.phoneNumber?.transferNumber && baseUrl) {
    return transferTwiml({
      transferNumber: phoneCall.phoneNumber.transferNumber,
      callerId: phoneCall.remoteNumber ?? phoneCall.phoneNumber.e164,
      actionUrl: telephonyWebhookUrl(baseUrl, "twilio/transfer-result", { conversation: conversationId }),
      announce: SPOKEN.connectingTransfer,
    });
  }

  const legSeconds = parseSeconds(form.DialCallDuration);
  if (legSeconds != null) {
    await prisma.phoneCall.updateMany({ where: { id: phoneCall.id, aiLegSeconds: null }, data: { aiLegSeconds: legSeconds } });
  }

  const aiAnswered = Boolean(phoneCall.conversation.tokenIssuedAt) && phoneCall.conversation.status !== "FAILED";
  if (form.DialCallStatus === "completed" && aiAnswered) {
    await settlePhoneConversation(conversationId, {
      reason: "call_ended",
      source: legSeconds != null ? "provider_reported" : "server_clock",
      chargedSeconds: legSeconds ?? undefined,
      now,
    });
    return hangUpTwiml();
  }

  await prisma.phoneCall.update({
    where: { id: phoneCall.id },
    data: { failureReason: `ai_leg_${(form.DialCallStatus || "unknown").slice(0, 30)}` },
  });
  await settlePhoneConversation(conversationId, {
    reason: "ai_leg_failed",
    source: legSeconds != null ? "provider_reported" : "server_clock",
    chargedSeconds: legSeconds ?? undefined,
    failed: true,
    now,
  });
  if (phoneCall.direction === "OUTBOUND" || !phoneCall.phoneNumber) {
    return sayAndHangUpTwiml(SPOKEN.unavailable(phoneCall.organization.name));
  }
  return fallbackTwiml({
    organizationName: phoneCall.organization.name,
    transferNumber: phoneCall.phoneNumber.transferNumber,
    callerId: phoneCall.remoteNumber ?? phoneCall.phoneNumber.e164,
    baseUrl,
  });
}

/** Dial action for a transfer or fallback to the business's human line. */
export async function handleTransferResult(
  conversationId: string | null,
  form: TwilioForm
): Promise<string> {
  const answered = form.DialCallStatus === "completed";
  if (conversationId) {
    const phoneCall = await findCallForCallback(conversationId, form.CallSid);
    if (phoneCall) {
      await prisma.phoneCall.updateMany({
        where: { id: phoneCall.id, transferStatus: "REQUESTED" },
        data: { transferStatus: answered ? "CONNECTED" : "MISSED" },
      });
    }
  }
  return answered ? hangUpTwiml() : sayAndHangUpTwiml(SPOKEN.transferMissed);
}

// --- Outbound ---

/**
 * Twilio requests this when the person we called picks up. Answering machines are hung up on. A
 * person hears who is calling and how to stop future calls before the AI joins.
 */
export async function handleOutboundAnswer(conversationId: string, form: TwilioForm, now: Date = new Date()): Promise<string> {
  const phoneCall = await prisma.phoneCall.findUnique({
    where: { conversationId },
    include: { conversation: true, organization: true },
  });
  if (!phoneCall || phoneCall.direction !== "OUTBOUND" || !form.CallSid) {
    return hangUpTwiml();
  }
  if (phoneCall.providerCallSid && phoneCall.providerCallSid !== form.CallSid) {
    return hangUpTwiml();
  }
  // The answer can beat our own write of the CallSid from the create response.
  await prisma.phoneCall.updateMany({
    where: { id: phoneCall.id, providerCallSid: null },
    data: { providerCallSid: form.CallSid },
  });
  if (form.AnsweredBy) {
    await prisma.phoneCall.update({ where: { id: phoneCall.id }, data: { answeredBy: form.AnsweredBy.slice(0, 40) } });
  }
  if (phoneCall.conversation.status !== "ACTIVE") {
    return hangUpTwiml();
  }
  if (isAnsweringMachine(form.AnsweredBy)) {
    await settlePhoneConversation(conversationId, { reason: "answering_machine", source: "server_clock", now });
    return hangUpTwiml();
  }
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    await settlePhoneConversation(conversationId, { reason: "not_configured", source: "server_clock", failed: true, now });
    return hangUpTwiml();
  }
  return outboundAnswerTwiml({
    organizationName: phoneCall.organization.name,
    keypadActionUrl: telephonyWebhookUrl(baseUrl, "twilio/outbound-keypad", { conversation: conversationId }),
  });
}

/** After the outbound announcement: 9 adds the number to the do-not-call list; anything else connects the AI. */
export async function handleOutboundKeypad(conversationId: string, form: TwilioForm, now: Date = new Date()): Promise<string> {
  const phoneCall = await findCallForCallback(conversationId, form.CallSid);
  if (!phoneCall || phoneCall.direction !== "OUTBOUND") {
    return hangUpTwiml();
  }
  if (form.Digits === OPT_OUT_DIGIT) {
    if (phoneCall.remoteNumber) {
      await recordOptOut(prisma, {
        organizationId: phoneCall.organizationId,
        phoneNumber: phoneCall.remoteNumber,
        source: "CALLER_KEYPAD",
      });
    }
    await settlePhoneConversation(conversationId, { reason: "opted_out", source: "server_clock", now });
    return sayAndHangUpTwiml(SPOKEN.optedOut(phoneCall.organization.name));
  }
  if (phoneCall.conversation.status !== "ACTIVE") {
    return hangUpTwiml();
  }
  const sip = getRealtimeSipConfig();
  const baseUrl = getPublicBaseUrl();
  if (!sip || !baseUrl) {
    await settlePhoneConversation(conversationId, { reason: "ai_not_configured", source: "server_clock", failed: true, now });
    return sayAndHangUpTwiml(SPOKEN.unavailable(phoneCall.organization.name));
  }
  return aiDialTwiml({
    conversationId,
    reservedSeconds: phoneCall.conversation.reservedSeconds,
    baseUrl,
    projectId: sip.projectId,
  });
}

// --- Status callbacks (both directions) ---

export type StatusCallbackResult = "applied" | "duplicate" | "ignored";

/**
 * Twilio's call-progress callbacks. The row is locked while the status is compared and written, so
 * concurrent callbacks for one call apply in order. On a terminal status the carrier seconds are
 * recorded (platform cost) and the conversation settles if no Dial action already settled it.
 */
export async function handleCallStatus(form: TwilioForm, now: Date = new Date()): Promise<StatusCallbackResult> {
  const callSid = form.CallSid;
  const status = form.CallStatus ?? "";
  const eventKey = `${callSid}:status:${form.SequenceNumber ?? status}`;
  if (!callSid || (await seenEvent("TWILIO", eventKey))) {
    return "duplicate";
  }

  const applied = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; providerStatus: string }>>`
      SELECT "id", "providerStatus" FROM "PhoneCall" WHERE "providerCallSid" = ${callSid} FOR UPDATE`;
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (!shouldApplyStatus(row.providerStatus, status)) {
      return { phoneCallId: row.id, applied: false };
    }
    const terminal = isTerminalStatus(status);
    await tx.phoneCall.update({
      where: { id: row.id },
      data: {
        providerStatus: status,
        ...(form.AnsweredBy && { answeredBy: form.AnsweredBy.slice(0, 40) }),
        ...(terminal && { endedAt: now, carrierSeconds: parseSeconds(form.CallDuration) }),
      },
    });
    return { phoneCallId: row.id, applied: true };
  });

  if (!applied) {
    await logEvent({ source: "TWILIO", eventKey, eventType: "status", status: "IGNORED", note: "unknown_call" });
    return "ignored";
  }
  const phoneCall = await prisma.phoneCall.findUniqueOrThrow({
    where: { id: applied.phoneCallId },
    include: { conversation: true },
  });
  if (!applied.applied) {
    await logEvent({
      source: "TWILIO",
      eventKey,
      eventType: "status",
      status: "IGNORED",
      organizationId: phoneCall.organizationId,
      note: "out_of_order",
    });
    return "ignored";
  }

  if (isTerminalStatus(status)) {
    if (phoneCall.carrierSeconds && phoneCall.carrierSeconds > 0) {
      await recordCarrierUsage(prisma, {
        organizationId: phoneCall.organizationId,
        agentId: phoneCall.conversation.agentId,
        conversationId: phoneCall.conversationId,
        seconds: phoneCall.carrierSeconds,
        occurredAt: phoneCall.createdAt,
        provider: CARRIER_PROVIDER_ID,
        model: `pstn-${phoneCall.direction.toLowerCase()}`,
        source: "provider_reported",
      });
    }
    // Normally the Dial action already settled; this covers a missed or never-sent action.
    await settlePhoneConversation(phoneCall.conversationId, {
      reason: status === "completed" ? "call_ended" : `call_${status}`,
      source: "server_clock",
      failed: status === "failed",
      now,
    });
  }
  await logEvent({
    source: "TWILIO",
    eventKey,
    eventType: "status",
    status: "PROCESSED",
    organizationId: phoneCall.organizationId,
  });
  return "applied";
}
