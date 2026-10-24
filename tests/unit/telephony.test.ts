import { afterEach, describe, expect, it } from "vitest";

import { maskPhoneNumber, toE164 } from "@/lib/phone";
import {
  getOutboundCallingCodes,
  MAX_PHONE_SESSION_SECONDS,
  realtimeSipUri,
  SIDEBAND_FUNCTION_MAX_SECONDS,
  telephonyWebhookUrl,
} from "@/server/telephony/config";
import { priceToMicros, verifyTwilioSignature } from "@/server/telephony/twilio";
import { conversationIdFromSipHeaders } from "@/server/telephony/realtimeSip";
import { isTerminalStatus, shouldApplyStatus } from "@/server/telephony/lifecycle";
import { isAllowedDestination, isWithinCallingHours } from "@/server/telephony/outbound";
import { connectAiTwiml, inboundAnswerTwiml, outboundAnswerTwiml, sayAndHangUpTwiml, transferTwiml } from "@/server/telephony/twiml";
import { PHONE_TOOL, phoneToolsFor } from "@/server/telephony/toolDefinitions";
import { classifyOutcome } from "@/server/conversations/outcome";
import { COST_RATE_KEYS, isCostRateKeyId } from "@/server/billing/costRates";
import {
  optOutSchema,
  outboundCallSchema,
  phoneNumberSettingsSchema,
  registerPhoneNumberSchema,
} from "@/lib/validation/phone";
import { maxDuration } from "@/app/api/telephony/openai/route";

const CONVERSATION_ID = "0b8f4c1e-6d2a-4f7b-9c3e-1a2b3c4d5e6f";

describe("phone numbers", () => {
  it.each([
    ["024 123 4567", "+233241234567"],
    ["0241234567", "+233241234567"],
    ["233241234567", "+233241234567"],
    ["+233 (24) 123-4567", "+233241234567"],
    ["00233241234567", "+233241234567"],
    ["+1 415 555 0100", "+14155550100"],
  ])("normalises %s to E.164", (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each(["", "12345", "+0123456789", "024 123", "abc", "+2332412345678901"])("rejects %j", (input) => {
    expect(toE164(input)).toBeNull();
  });

  it("masks all but the last three digits", () => {
    expect(maskPhoneNumber("+233241234567")).toBe("+233 ••• ••• 567");
    expect(maskPhoneNumber("+14155550100")).toBe("+1 ••• ••• 100");
    expect(maskPhoneNumber(null)).toBe("Unknown");
  });
});

describe("Twilio webhook signatures", () => {
  // Twilio's own worked example (twilio.com/docs/usage/security).
  const example = {
    authToken: "12345",
    url: "https://example.com/myapp.php?foo=1&bar=2",
    form: {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    },
  };

  it("accepts Twilio's documented example signature", () => {
    expect(verifyTwilioSignature({ ...example, signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=" })).toBe(true);
  });

  it("rejects a missing, wrong or tampered signature", () => {
    expect(verifyTwilioSignature({ ...example, signature: null })).toBe(false);
    expect(verifyTwilioSignature({ ...example, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" })).toBe(false);
    expect(
      verifyTwilioSignature({ ...example, form: { ...example.form, Digits: "9999" }, signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=" })
    ).toBe(false);
    expect(
      verifyTwilioSignature({ ...example, url: "https://evil.example/myapp.php?foo=1&bar=2", signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=" })
    ).toBe(false);
  });

  it("converts Twilio prices (negative decimal strings) to positive micro-units", () => {
    expect(priceToMicros("-0.01300")).toBe(13_000);
    expect(priceToMicros("0.5")).toBe(500_000);
    expect(priceToMicros(null)).toBeNull();
    expect(priceToMicros("")).toBeNull();
    expect(priceToMicros("n/a")).toBeNull();
  });
});

describe("call status ordering", () => {
  it("only moves a call forward and never out of a terminal status", () => {
    expect(shouldApplyStatus("queued", "ringing")).toBe(true);
    expect(shouldApplyStatus("ringing", "in-progress")).toBe(true);
    expect(shouldApplyStatus("in-progress", "completed")).toBe(true);
    expect(shouldApplyStatus("in-progress", "ringing")).toBe(false);
    expect(shouldApplyStatus("completed", "in-progress")).toBe(false);
    expect(shouldApplyStatus("completed", "completed")).toBe(false);
    expect(shouldApplyStatus("ringing", "no-answer")).toBe(true);
    expect(shouldApplyStatus("ringing", "made-up")).toBe(false);
  });

  it("knows the terminal statuses", () => {
    for (const status of ["completed", "busy", "failed", "no-answer", "canceled"]) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    expect(isTerminalStatus("in-progress")).toBe(false);
  });
});

describe("SIP correlation", () => {
  it("builds the OpenAI SIP URI with the conversation header", () => {
    expect(realtimeSipUri("proj_abc", CONVERSATION_ID)).toBe(
      `sip:proj_abc@sip.api.openai.com;transport=tls?X-Sunleon-Conversation=${CONVERSATION_ID}`
    );
  });

  it("reads only a well-formed conversation id from the SIP headers, case-insensitively", () => {
    expect(conversationIdFromSipHeaders([{ name: "x-sunleon-conversation", value: CONVERSATION_ID.toUpperCase() }])).toBe(
      CONVERSATION_ID
    );
    expect(conversationIdFromSipHeaders([{ name: "X-Sunleon-Conversation", value: "'; DROP TABLE" }])).toBeNull();
    expect(conversationIdFromSipHeaders([{ name: "From", value: "sip:+233@x" }])).toBeNull();
    expect(conversationIdFromSipHeaders([])).toBeNull();
  });

  it("builds webhook URLs from the configured origin", () => {
    expect(telephonyWebhookUrl("https://voice.example.com", "twilio/status")).toBe(
      "https://voice.example.com/api/telephony/twilio/status"
    );
    expect(telephonyWebhookUrl("https://voice.example.com", "twilio/ai-dial-result", { conversation: "abc" })).toBe(
      "https://voice.example.com/api/telephony/twilio/ai-dial-result?conversation=abc"
    );
  });

  it("keeps every phone session inside one function invocation", () => {
    expect(maxDuration).toBe(SIDEBAND_FUNCTION_MAX_SECONDS);
    // Reservation + sideband grace (20 s) must finish before the function is stopped.
    expect(MAX_PHONE_SESSION_SECONDS + 20).toBeLessThanOrEqual(SIDEBAND_FUNCTION_MAX_SECONDS);
  });
});

describe("outbound rules", () => {
  const original = process.env.TELEPHONY_OUTBOUND_CALLING_CODES;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.TELEPHONY_OUTBOUND_CALLING_CODES;
    } else {
      process.env.TELEPHONY_OUTBOUND_CALLING_CODES = original;
    }
  });

  it("allows calls 08:00–20:00 Ghana time (UTC) only", () => {
    expect(isWithinCallingHours(new Date("2026-10-23T07:59:00Z"))).toBe(false);
    expect(isWithinCallingHours(new Date("2026-10-23T08:00:00Z"))).toBe(true);
    expect(isWithinCallingHours(new Date("2026-10-23T19:59:00Z"))).toBe(true);
    expect(isWithinCallingHours(new Date("2026-10-23T20:00:00Z"))).toBe(false);
  });

  it("allows Ghana only by default, or the configured calling codes", () => {
    delete process.env.TELEPHONY_OUTBOUND_CALLING_CODES;
    expect(getOutboundCallingCodes()).toEqual(["233"]);
    expect(isAllowedDestination("+233241234567", getOutboundCallingCodes())).toBe(true);
    expect(isAllowedDestination("+14155550100", getOutboundCallingCodes())).toBe(false);

    process.env.TELEPHONY_OUTBOUND_CALLING_CODES = "+233, 1, bad, 44";
    expect(getOutboundCallingCodes()).toEqual(["233", "1", "44"]);
  });
});

describe("TwiML", () => {
  it("announces the AI and dials the SIP leg with the reservation as a hard limit", () => {
    const xml = inboundAnswerTwiml({
      organizationName: "Kofi & Sons <Bakery>",
      sipUri: realtimeSipUri("proj_abc", CONVERSATION_ID),
      dialActionUrl: "https://voice.example.com/api/telephony/twilio/ai-dial-result?conversation=x",
      timeLimitSeconds: 270,
    });
    expect(xml).toContain("Kofi &amp; Sons &lt;Bakery&gt;");
    expect(xml).toContain("answered by an AI assistant");
    expect(xml).toContain('timeLimit="270"');
    expect(xml).toMatch(/<Sip>sip:proj_abc@sip\.api\.openai\.com;transport=tls\?X-Sunleon-Conversation=/);
    expect(xml).not.toContain("<Bakery>");
  });

  it("gives outbound callers the opt-out key before the AI joins", () => {
    const xml = outboundAnswerTwiml({ organizationName: "Ama's Salon", keypadActionUrl: "https://voice.example.com/k" });
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('actionOnEmptyResult="true"');
    expect(xml).toContain("press 9");
    expect(xml).toContain("automated AI assistant");
  });

  it("builds connect, transfer and hang-up responses", () => {
    expect(connectAiTwiml({ sipUri: "sip:a@b", dialActionUrl: "https://x/y", timeLimitSeconds: 60 })).toContain(
      '<Dial action="https://x/y" method="POST" timeLimit="60"><Sip>sip:a@b</Sip></Dial>'
    );
    const transfer = transferTwiml({
      transferNumber: "+233301234567",
      callerId: "+233241234567",
      actionUrl: "https://x/t",
      announce: "Connecting you.",
    });
    expect(transfer).toContain('callerId="+233241234567"');
    expect(transfer).toContain(">+233301234567</Dial>");
    expect(sayAndHangUpTwiml("Goodbye.")).toMatch(/<Say[^>]*>Goodbye\.<\/Say><Hangup\/>/);
  });
});

describe("phone tools and outcomes", () => {
  it("only offers contact capture and transfer when the business enabled them", () => {
    const names = (tools: ReturnType<typeof phoneToolsFor>) => tools.map((tool) => tool.name);
    expect(names(phoneToolsFor({ leadCapture: false, transferAvailable: false }))).toEqual([
      PHONE_TOOL.searchKnowledge,
      PHONE_TOOL.optOut,
      PHONE_TOOL.endCall,
    ]);
    expect(names(phoneToolsFor({ leadCapture: true, transferAvailable: true }))).toEqual([
      PHONE_TOOL.searchKnowledge,
      PHONE_TOOL.saveContact,
      PHONE_TOOL.transfer,
      PHONE_TOOL.optOut,
      PHONE_TOOL.endCall,
    ]);
  });

  it("ranks a transfer above a lead but below failure and not connecting", () => {
    const base = { failed: false, connected: true, leadCount: 1, abandoned: false, chargedSeconds: 60 };
    expect(classifyOutcome({ ...base, transferred: true })).toBe("TRANSFERRED");
    expect(classifyOutcome({ ...base, transferred: false })).toBe("LEAD_CAPTURED");
    expect(classifyOutcome({ ...base, transferred: true, connected: false })).toBe("NOT_CONNECTED");
    expect(classifyOutcome({ ...base, transferred: true, failed: true })).toBe("FAILED");
  });

  it("has a cost rate key for every phone usage stream", () => {
    expect(isCostRateKeyId("carrier-inbound")).toBe(true);
    expect(isCostRateKeyId("toString")).toBe(false);
    expect(COST_RATE_KEYS["phone-ai"]).toMatchObject({ metric: "VOICE_SECONDS", provider: "openai-realtime-sip" });
    expect(COST_RATE_KEYS["carrier-outbound"]).toMatchObject({ metric: "TELEPHONY_SECONDS", model: "pstn-outbound" });
  });
});

describe("phone validation", () => {
  it("normalises transfer numbers and checkboxes", () => {
    expect(
      phoneNumberSettingsSchema.parse({ agentId: "", transferNumber: "024 123 4567", inboundEnabled: "on", outboundEnabled: null })
    ).toEqual({ agentId: null, transferNumber: "+233241234567", inboundEnabled: true, outboundEnabled: false });
    expect(phoneNumberSettingsSchema.safeParse({ agentId: "", transferNumber: "123", inboundEnabled: null, outboundEnabled: null }).success).toBe(
      false
    );
  });

  it("needs a lead or a number for an outbound call", () => {
    expect(outboundCallSchema.safeParse({ phoneNumberId: "n1", leadId: "", destination: "", requestConfirmed: null }).success).toBe(false);
    expect(
      outboundCallSchema.parse({ phoneNumberId: "n1", leadId: "", destination: "0241234567", requestConfirmed: "on" })
    ).toMatchObject({ leadId: undefined, requestConfirmed: true });
  });

  it("validates opt-out numbers and Twilio number SIDs", () => {
    expect(optOutSchema.parse({ phoneNumber: "0241234567" }).phoneNumber).toBe("+233241234567");
    expect(optOutSchema.safeParse({ phoneNumber: "hello" }).success).toBe(false);
    const valid = { e164: "+233301234567", organizationSlug: "kofi", label: "" };
    expect(registerPhoneNumberSchema.safeParse({ ...valid, providerNumberSid: `PN${"a".repeat(32)}` }).success).toBe(true);
    expect(registerPhoneNumberSchema.safeParse({ ...valid, providerNumberSid: "PN123" }).success).toBe(false);
    expect(registerPhoneNumberSchema.parse({ ...valid, providerNumberSid: "" }).providerNumberSid).toBeNull();
  });
});
