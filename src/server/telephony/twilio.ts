import "server-only";

import twilio from "twilio";

import { getTwilioCredentials } from "./config";

export class MissingCarrierCredentialsError extends Error {
  constructor() {
    super(
      "Phone calling is not configured: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set. " +
        "See docs/PROVIDER_INTEGRATIONS.md."
    );
  }
}

export class CarrierRequestError extends Error {}

export interface CreateCarrierCallParams {
  to: string;
  from: string;
  /** Twilio requests TwiML from here when the call is answered. */
  answerUrl: string;
  statusCallbackUrl: string;
  ringTimeoutSeconds: number;
  /** Carrier-side hard stop for the whole call. */
  timeLimitSeconds: number;
}

export interface CarrierCallRecord {
  status: string;
  durationSeconds: number | null;
  /** Micro-units of priceUnit, as a positive cost. Null until the carrier has priced the call. */
  priceMicros: number | null;
  priceUnit: string | null;
}

/** The carrier operations the app uses. Twilio is the only implementation; tests use a fake. */
export interface TelephonyCarrier {
  createCall(params: CreateCarrierCallParams): Promise<{ callSid: string }>;
  /** Replaces the live call's instructions (used to transfer a caller to a human). */
  redirectCall(callSid: string, twiml: string): Promise<void>;
  fetchCall(callSid: string): Promise<CarrierCallRecord>;
}

/**
 * Twilio's documented webhook check (HMAC-SHA1 over the URL plus the sorted POST parameters, keyed
 * with the auth token), done by the official SDK helper rather than re-implemented.
 */
export function verifyTwilioSignature(params: {
  authToken: string;
  signature: string | null;
  url: string;
  form: Record<string, string>;
}): boolean {
  if (!params.signature) {
    return false;
  }
  return twilio.validateRequest(params.authToken, params.signature, params.url, params.form);
}

/** Twilio prices are decimal strings, negative for charges (e.g. "-0.01300"). */
export function priceToMicros(price: string | null | undefined): number | null {
  if (price == null || price.trim() === "") {
    return null;
  }
  const value = Number(price);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.abs(value) * 1_000_000);
}

export class TwilioCarrier implements TelephonyCarrier {
  private client() {
    const credentials = getTwilioCredentials();
    if (!credentials) {
      throw new MissingCarrierCredentialsError();
    }
    return twilio(credentials.accountSid, credentials.authToken);
  }

  async createCall(params: CreateCarrierCallParams): Promise<{ callSid: string }> {
    const call = await this.client().calls.create({
      to: params.to,
      from: params.from,
      url: params.answerUrl,
      method: "POST",
      statusCallback: params.statusCallbackUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: params.ringTimeoutSeconds,
      timeLimit: params.timeLimitSeconds,
      // Answering machines get a hang-up, not an AI monologue on someone's voicemail.
      machineDetection: "Enable",
    });
    return { callSid: call.sid };
  }

  async redirectCall(callSid: string, twiml: string): Promise<void> {
    await this.client().calls(callSid).update({ twiml });
  }

  async fetchCall(callSid: string): Promise<CarrierCallRecord> {
    const call = await this.client().calls(callSid).fetch();
    const duration = Number.parseInt(call.duration ?? "", 10);
    return {
      status: call.status,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      priceMicros: priceToMicros(call.price),
      priceUnit: call.priceUnit ?? null,
    };
  }
}

export function getTelephonyCarrier(): TelephonyCarrier {
  return new TwilioCarrier();
}
