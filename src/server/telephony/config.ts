import "server-only";

import { GHANA_CALLING_CODE } from "@/lib/phone";

/**
 * Phone calls: Twilio Programmable Voice carries the call (numbers, webhooks, status callbacks,
 * time limits, transfers) and dials the OpenAI Realtime SIP endpoint, which runs the AI. Our
 * server only answers HTTP webhooks — no media passes through it. See docs/PROVIDER_INTEGRATIONS.md.
 */
export const CARRIER_PROVIDER_ID = "twilio";
export const SIP_VOICE_PROVIDER_ID = "openai-realtime-sip";
/** Same model family as the browser path (openai/gpt-realtime-2 through the Gateway). */
export const REALTIME_SIP_MODEL = "gpt-realtime-2";

/** Custom SIP header Twilio adds to the INVITE and OpenAI echoes back in realtime.call.incoming. */
export const SIP_CONVERSATION_HEADER = "X-Sunleon-Conversation";

/**
 * Longest phone session. The AI's tool connection for a call runs inside the OpenAI webhook's
 * function invocation, which Vercel stops at maxDuration (300 s, the most every plan allows), so a
 * call must end before then; Twilio's Dial timeLimit enforces it on the carrier side. On Vercel Pro
 * both can be raised together (maxDuration up to 800 s) — see docs/DEPLOYMENT_RUNBOOK.md.
 */
export const MAX_PHONE_SESSION_SECONDS = 270;
/** Must stay a literal in the route file; kept here so the relationship is documented and tested. */
export const SIDEBAND_FUNCTION_MAX_SECONDS = 300;
/** OpenAI must ask us to accept the AI leg within this long of the call being set up. */
export const AI_ACCEPT_WINDOW_MS = 2 * 60 * 1000;

export const OUTBOUND_CALLS_PER_HOUR = 20;
/** The same person isn't called twice within this window, whoever places the call. */
export const OUTBOUND_REPEAT_COOLDOWN_MS = 10 * 60 * 1000;
/** Ghana (Africa/Accra) is UTC+0 all year, so calling hours are checked in UTC. */
export const CALLING_HOURS_UTC = { startHour: 8, endHour: 20 } as const;
export const OUTBOUND_RING_TIMEOUT_SECONDS = 30;
export const TRANSFER_RING_TIMEOUT_SECONDS = 25;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

export interface RealtimeSipConfig {
  apiKey: string;
  webhookSecret: string;
  projectId: string;
}

export function getTwilioCredentials(): TwilioCredentials | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

export function getRealtimeSipConfig(): RealtimeSipConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const webhookSecret = process.env.OPENAI_WEBHOOK_SECRET?.trim();
  const projectId = process.env.OPENAI_PROJECT_ID?.trim();
  return apiKey && webhookSecret && projectId ? { apiKey, webhookSecret, projectId } : null;
}

/**
 * The public origin Twilio calls us on. Twilio signs the exact URL it requested, so signatures are
 * checked against this configured origin, never the request's Host header.
 */
export function getPublicBaseUrl(): string | null {
  const url = process.env.NEXTAUTH_URL?.trim().replace(/\/$/, "");
  return url ? url : null;
}

export function telephonyWebhookUrl(baseUrl: string, path: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `${baseUrl}/api/telephony/${path}${search ? `?${search}` : ""}`;
}

/** Country calling codes outbound calls may go to. Ghana only unless configured — limits toll fraud. */
export function getOutboundCallingCodes(): string[] {
  const configured = process.env.TELEPHONY_OUTBOUND_CALLING_CODES?.split(",")
    .map((code) => code.trim().replace(/^\+/, ""))
    .filter((code) => /^\d{1,3}$/.test(code));
  return configured && configured.length > 0 ? configured : [GHANA_CALLING_CODE];
}

/** The OpenAI SIP endpoint for our project, carrying the conversation id as a custom header. */
export function realtimeSipUri(projectId: string, conversationId: string): string {
  return `sip:${projectId}@sip.api.openai.com;transport=tls?${SIP_CONVERSATION_HEADER}=${encodeURIComponent(conversationId)}`;
}
