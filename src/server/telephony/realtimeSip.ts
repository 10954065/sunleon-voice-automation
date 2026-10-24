import "server-only";

import OpenAI from "openai";
import type { CallAcceptParams } from "openai/resources/realtime/calls";

import { getRealtimeSipConfig, SIP_CONVERSATION_HEADER } from "./config";

export class MissingRealtimeSipCredentialsError extends Error {
  constructor() {
    super(
      "Phone AI is not configured: OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET and OPENAI_PROJECT_ID are not all set. " +
        "See docs/PROVIDER_INTEGRATIONS.md."
    );
  }
}

export type RealtimeSessionForCall = Omit<CallAcceptParams, "type">;

/** OpenAI Realtime SIP call control. One implementation (the official SDK); tests use a fake. */
export interface RealtimeCallControl {
  accept(callId: string, session: RealtimeSessionForCall): Promise<void>;
  /** Declines a call we can't match to a session we set up. 603 = Decline. */
  reject(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
}

export interface IncomingRealtimeCall {
  webhookId: string;
  callId: string;
  conversationId: string | null;
}

function client(): OpenAI {
  const config = getRealtimeSipConfig();
  if (!config) {
    throw new MissingRealtimeSipCredentialsError();
  }
  return new OpenAI({ apiKey: config.apiKey, webhookSecret: config.webhookSecret });
}

export class OpenAIRealtimeCallControl implements RealtimeCallControl {
  async accept(callId: string, session: RealtimeSessionForCall): Promise<void> {
    await client().realtime.calls.accept(callId, { type: "realtime", ...session });
  }

  async reject(callId: string): Promise<void> {
    await client().realtime.calls.reject(callId, { status_code: 603 });
  }

  async hangup(callId: string): Promise<void> {
    await client().realtime.calls.hangup(callId);
  }
}

export function getRealtimeCallControl(): RealtimeCallControl {
  return new OpenAIRealtimeCallControl();
}

export class InvalidRealtimeWebhookError extends Error {}

/** Header values are untrusted call metadata (OpenAI's own wording); this only reads our own header. */
export function conversationIdFromSipHeaders(headers: Array<{ name: string; value: string }>): string | null {
  const wanted = SIP_CONVERSATION_HEADER.toLowerCase();
  const header = headers.find((entry) => entry.name.toLowerCase() === wanted);
  const value = header?.value.trim();
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * Verifies the Standard Webhooks signature with the official SDK (HMAC-SHA256 over
 * "id.timestamp.body", five-minute tolerance) and returns the incoming-call details, or null for
 * any other event type. Throws InvalidRealtimeWebhookError when the signature doesn't check out.
 */
export async function parseRealtimeWebhook(rawBody: string, headers: Headers): Promise<IncomingRealtimeCall | null> {
  let event;
  try {
    event = await client().webhooks.unwrap(rawBody, headers);
  } catch (error) {
    if (error instanceof MissingRealtimeSipCredentialsError) {
      throw error;
    }
    throw new InvalidRealtimeWebhookError(error instanceof Error ? error.message : "Invalid webhook.");
  }
  if (event.type !== "realtime.call.incoming") {
    return null;
  }
  return {
    webhookId: headers.get("webhook-id") ?? event.id,
    callId: event.data.call_id,
    conversationId: conversationIdFromSipHeaders(event.data.sip_headers ?? []),
  };
}
