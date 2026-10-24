import "server-only";

import twilio from "twilio";

import { TRANSFER_RING_TIMEOUT_SECONDS } from "./config";

const { VoiceResponse } = twilio.twiml;
/** Ghanaian callers are closer to British than American English; Twilio's default voice supports it. */
const SAY = { language: "en-GB" } as const;
const OUTBOUND_KEYPAD_SECONDS = 4;
/** The keypad digit that stops future outbound calls from this business. */
export const OPT_OUT_DIGIT = "9";

/** Inbound: the spoken AI disclosure, then the AI leg over SIP with the reservation as a hard time limit. */
export function inboundAnswerTwiml(params: {
  organizationName: string;
  sipUri: string;
  dialActionUrl: string;
  timeLimitSeconds: number;
}): string {
  const response = new VoiceResponse();
  response.say(SAY, `You've reached ${params.organizationName}. This call is answered by an AI assistant.`);
  appendAiDial(response, params);
  return response.toString();
}

/**
 * Outbound: who is calling and why, and how to stop future calls, before any AI speaks. The keypad
 * action runs even with no key pressed (actionOnEmptyResult), so one handler decides what's next.
 */
export function outboundAnswerTwiml(params: { organizationName: string; keypadActionUrl: string }): string {
  const response = new VoiceResponse();
  const gather = response.gather({
    numDigits: 1,
    timeout: OUTBOUND_KEYPAD_SECONDS,
    action: params.keypadActionUrl,
    method: "POST",
    actionOnEmptyResult: true,
  });
  gather.say(
    SAY,
    `Hello. This is an automated AI assistant calling on behalf of ${params.organizationName}, following up on your request. ` +
      `If you don't want calls from ${params.organizationName}, press ${OPT_OUT_DIGIT} now. Otherwise, please hold.`
  );
  return response.toString();
}

export function connectAiTwiml(params: { sipUri: string; dialActionUrl: string; timeLimitSeconds: number }): string {
  const response = new VoiceResponse();
  appendAiDial(response, params);
  return response.toString();
}

function appendAiDial(
  response: InstanceType<typeof VoiceResponse>,
  params: { sipUri: string; dialActionUrl: string; timeLimitSeconds: number }
): void {
  const dial = response.dial({
    action: params.dialActionUrl,
    method: "POST",
    timeLimit: params.timeLimitSeconds,
  });
  dial.sip(params.sipUri);
}

/** Hands the caller to the business's human line; the action URL learns whether anyone answered. */
export function transferTwiml(params: { transferNumber: string; callerId: string; actionUrl: string; announce: string }): string {
  const response = new VoiceResponse();
  response.say(SAY, params.announce);
  response.dial(
    { callerId: params.callerId, timeout: TRANSFER_RING_TIMEOUT_SECONDS, action: params.actionUrl, method: "POST" },
    params.transferNumber
  );
  return response.toString();
}

export function sayAndHangUpTwiml(message: string): string {
  const response = new VoiceResponse();
  response.say(SAY, message);
  response.hangup();
  return response.toString();
}

export function hangUpTwiml(): string {
  const response = new VoiceResponse();
  response.hangup();
  return response.toString();
}

export const SPOKEN = {
  notInService: "Sorry, this number is not in service.",
  unavailable: (organizationName: string) =>
    `Sorry, ${organizationName} can't take your call right now. Please try again later. Goodbye.`,
  connectingFallback: "Please hold while we connect you to a member of the team.",
  connectingTransfer: "Connecting you to a member of the team now.",
  transferMissed:
    "Sorry, no one is available to take your call right now. The team will see that you called and get back to you. Goodbye.",
  optedOut: (organizationName: string) =>
    `You won't receive further calls from ${organizationName}. Goodbye.`,
};
