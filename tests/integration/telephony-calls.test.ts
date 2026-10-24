import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { resetDatabase, seedVoiceOrganization } from "./helpers";
import type { SidebandServerEvent } from "@/server/telephony/sideband";
import type { CarrierCallRecord } from "@/server/telephony/twilio";

const mocks = vi.hoisted(() => ({
  callControl: {
    accept: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
  },
  afterTasks: [] as Array<() => unknown>,
  runSidebandForCall: vi.fn(async () => undefined),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => {
    mocks.afterTasks.push(task);
  }),
}));
vi.mock("@/server/telephony/realtimeSip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/telephony/realtimeSip")>()),
  getRealtimeCallControl: () => mocks.callControl,
}));
vi.mock("@/server/telephony/sideband", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/telephony/sideband")>()),
  runSidebandForCall: mocks.runSidebandForCall,
}));

const { POST: twilioRoute } = await import("@/app/api/telephony/twilio/[event]/route");
const { POST: openaiRoute } = await import("@/app/api/telephony/openai/route");
const { GET: reconcileRoute } = await import("@/app/api/cron/reconcile-telephony/route");
const { executePhoneTool } = await import("@/server/telephony/tools");
const { runSideband } = await import("@/server/telephony/sideband");
const { reconcileTelephonyCalls, getTelephonyReconciliationReport } = await import("@/server/telephony/reconciliation");

const BASE_URL = "https://voice.example.com";
const ACCOUNT_SID = `AC${"0".repeat(32)}`;
const AUTH_TOKEN = "test-auth-token";
const WEBHOOK_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
const OUR_NUMBER = "+233302000001";
const TRANSFER_NUMBER = "+233302000099";
const CALLER = "+233241234567";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_PROJECT_ID",
  "NEXTAUTH_URL",
  "CRON_SECRET",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setPhoneEnv() {
  process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.OPENAI_PROJECT_ID = "proj_test";
  process.env.NEXTAUTH_URL = BASE_URL;
}

/** Signs exactly as Twilio documents it: URL + sorted name/value pairs, HMAC-SHA1 with the auth token. */
function signTwilio(url: string, form: Record<string, string>, token = AUTH_TOKEN): string {
  const data = Object.keys(form)
    .sort()
    .reduce((acc, key) => acc + key + form[key], url);
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

async function twilioPost(
  event: string,
  form: Record<string, string>,
  options: { query?: string; signature?: string; signedUrlBase?: string } = {}
) {
  const path = `/api/telephony/twilio/${event}${options.query ?? ""}`;
  const signature = options.signature ?? signTwilio(`${options.signedUrlBase ?? BASE_URL}${path}`, form);
  const request = new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: new URLSearchParams(form).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
  });
  return twilioRoute(request, { params: Promise.resolve({ event }) });
}

/** Signs as the Standard Webhooks spec (and the OpenAI SDK) expects. */
function signOpenAI(body: string, id: string, timestamp: number): string {
  const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

async function openaiPost(params: { callId: string; conversationId?: string | null; webhookId?: string; badSignature?: boolean }) {
  const body = JSON.stringify({
    object: "event",
    id: `evt_${randomUUID()}`,
    type: "realtime.call.incoming",
    created_at: Math.floor(Date.now() / 1000),
    data: {
      call_id: params.callId,
      sip_headers: [
        { name: "From", value: `sip:${CALLER}@twilio.example` },
        ...(params.conversationId ? [{ name: "X-Sunleon-Conversation", value: params.conversationId }] : []),
      ],
    },
  });
  const webhookId = params.webhookId ?? `msg_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const request = new NextRequest("http://localhost/api/telephony/openai", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": params.badSignature ? "v1,AAAA" : signOpenAI(body, webhookId, timestamp),
    },
  });
  return { response: await openaiRoute(request), webhookId };
}

async function seedPhoneOrganization(slug: string, numberOverrides: Partial<{ transferNumber: string | null; e164: string }> = {}) {
  const seeded = await seedVoiceOrganization(slug, { publish: true, leadCapture: true });
  const phoneNumber = await prisma.phoneNumber.create({
    data: {
      organizationId: seeded.organization.id,
      agentId: seeded.agent.id,
      e164: numberOverrides.e164 ?? OUR_NUMBER,
      transferNumber: numberOverrides.transferNumber === undefined ? TRANSFER_NUMBER : numberOverrides.transferNumber,
      inboundEnabled: true,
      outboundEnabled: true,
    },
  });
  return { ...seeded, phoneNumber };
}

function inboundForm(callSid: string, extra: Record<string, string> = {}) {
  return { AccountSid: ACCOUNT_SID, CallSid: callSid, From: CALLER, To: OUR_NUMBER, CallStatus: "ringing", Direction: "inbound", ...extra };
}

function conversationIdFrom(xml: string): string {
  const match = xml.match(/X-Sunleon-Conversation=([0-9a-f-]{36})/);
  if (!match) {
    throw new Error(`No conversation id in TwiML: ${xml}`);
  }
  return match[1];
}

/** Inbound call answered by Twilio, then the AI leg accepted. Returns the conversation id. */
async function connectInboundCall(callSid: string, callId = `rtc_${randomUUID()}`) {
  const voice = await twilioPost("voice", inboundForm(callSid));
  const conversationId = conversationIdFrom(await voice.text());
  const { response } = await openaiPost({ callId, conversationId });
  expect(await response.json()).toEqual({ result: "accepted" });
  return { conversationId, callId };
}

const fakeCarrier = () => ({
  createCall: vi.fn(async () => ({ callSid: `CA${randomUUID().replace(/-/g, "")}` })),
  redirectCall: vi.fn(async () => undefined),
  fetchCall: vi.fn<(callSid: string) => Promise<CarrierCallRecord>>(async () => ({
    status: "completed",
    durationSeconds: 100,
    priceMicros: 13_000,
    priceUnit: "USD",
  })),
});

describe("phone calls", () => {
  beforeAll(setPhoneEnv);

  beforeEach(async () => {
    await resetDatabase();
    setPhoneEnv();
    mocks.afterTasks.length = 0;
    mocks.callControl.accept.mockReset().mockResolvedValue(undefined);
    mocks.callControl.reject.mockReset().mockResolvedValue(undefined);
    mocks.callControl.hangup.mockReset().mockResolvedValue(undefined);
    mocks.runSidebandForCall.mockReset();
  });

  afterAll(async () => {
    await resetDatabase();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe("an inbound call from start to finish", () => {
    it("announces the AI, accepts the AI leg server-side, bills Twilio's AI-leg time and records carrier time", async () => {
      const { organization } = await seedPhoneOrganization("inbound");

      const voice = await twilioPost("voice", inboundForm("CA_inbound_1"));
      const xml = await voice.text();
      expect(voice.status).toBe(200);
      expect(voice.headers.get("content-type")).toContain("text/xml");
      expect(xml).toContain("This call is answered by an AI assistant");
      expect(xml).toContain('timeLimit="270"');
      const conversationId = conversationIdFrom(xml);
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        organizationId: organization.id,
        channel: "PHONE",
        status: "ACTIVE",
        reservedSeconds: 270,
        tokenIssuedAt: null,
      });
      expect(await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).toMatchObject({
        direction: "INBOUND",
        remoteNumber: CALLER,
        providerCallSid: "CA_inbound_1",
      });

      const { response } = await openaiPost({ callId: "rtc_inbound_1", conversationId });
      expect(await response.json()).toEqual({ result: "accepted" });
      expect(mocks.callControl.accept).toHaveBeenCalledTimes(1);
      const [acceptedCallId, session] = mocks.callControl.accept.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(acceptedCallId).toBe("rtc_inbound_1");
      expect(session).toMatchObject({ model: "gpt-realtime-2", audio: { output: { voice: "alloy" } }, tool_choice: "auto" });
      expect(session.instructions).toContain("Phone call rules");
      expect(session.instructions).toContain(`Instructions for inbound`);
      expect((session.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain("transfer_to_human");
      expect(mocks.afterTasks).toHaveLength(1);
      await mocks.afterTasks[0]();
      expect(mocks.runSidebandForCall).toHaveBeenCalledWith({ conversationId, callId: "rtc_inbound_1", maxSeconds: 270 });

      expect((await twilioPost("status", inboundForm("CA_inbound_1", { CallStatus: "in-progress", SequenceNumber: "1" }))).status).toBe(200);

      const dial = await twilioPost(
        "ai-dial-result",
        inboundForm("CA_inbound_1", { CallStatus: "in-progress", DialCallStatus: "completed", DialCallDuration: "95" }),
        { query: `?conversation=${conversationId}` }
      );
      expect(await dial.text()).toContain("<Hangup/>");
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        status: "COMPLETED",
        outcome: "ENGAGED",
      });
      expect(await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId, metric: "VOICE_SECONDS" } })).toMatchObject({
        quantity: 95,
        source: "provider_reported",
        provider: "openai-realtime-sip",
        model: "gpt-realtime-2",
      });

      const completed = await twilioPost(
        "status",
        inboundForm("CA_inbound_1", { CallStatus: "completed", CallDuration: "102", SequenceNumber: "3" })
      );
      expect(await completed.json()).toEqual({ result: "applied" });
      expect(await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).toMatchObject({
        providerStatus: "completed",
        aiLegSeconds: 95,
        carrierSeconds: 102,
      });
      expect(await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId, metric: "TELEPHONY_SECONDS" } })).toMatchObject({
        quantity: 102,
        provider: "twilio",
        model: "pstn-inbound",
        source: "provider_reported",
      });
    });

    it("caps the AI charge at the reservation even if Twilio reports a longer leg", async () => {
      await seedPhoneOrganization("cap");
      const { conversationId } = await connectInboundCall("CA_cap");
      await twilioPost("ai-dial-result", inboundForm("CA_cap", { DialCallStatus: "completed", DialCallDuration: "400" }), {
        query: `?conversation=${conversationId}`,
      });
      const ledger = await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId, metric: "VOICE_SECONDS" } });
      expect(ledger.quantity).toBe(270);
      const ended = await prisma.usageEvent.findFirstOrThrow({ where: { conversationId, type: "SESSION_ENDED" } });
      expect(ended.metadata).toMatchObject({ chargedSeconds: 270, measuredSeconds: 400, usageSource: "provider_reported" });
    });
  });

  describe("idempotency", () => {
    it("treats repeated and out-of-order webhooks as no-ops", async () => {
      await seedPhoneOrganization("idem");
      const first = await twilioPost("voice", inboundForm("CA_idem"));
      const conversationId = conversationIdFrom(await first.text());
      // Twilio retries the voice webhook: same call, same conversation, no second reservation.
      const retry = await twilioPost("voice", inboundForm("CA_idem"));
      expect(conversationIdFrom(await retry.text())).toBe(conversationId);
      expect(await prisma.conversation.count()).toBe(1);

      const { response, webhookId } = await openaiPost({ callId: "rtc_idem", conversationId });
      expect(await response.json()).toEqual({ result: "accepted" });
      // OpenAI redelivers the same event, then (say) a second event id for the same call.
      expect(await (await openaiPost({ callId: "rtc_idem", conversationId, webhookId })).response.json()).toEqual({
        result: "duplicate",
      });
      expect(await (await openaiPost({ callId: "rtc_idem", conversationId })).response.json()).toEqual({ result: "duplicate" });
      expect(mocks.callControl.accept).toHaveBeenCalledTimes(1);
      expect(mocks.callControl.reject).not.toHaveBeenCalled();

      const dialForm = inboundForm("CA_idem", { DialCallStatus: "completed", DialCallDuration: "30" });
      await twilioPost("ai-dial-result", dialForm, { query: `?conversation=${conversationId}` });
      await twilioPost("ai-dial-result", dialForm, { query: `?conversation=${conversationId}` });

      const completedForm = inboundForm("CA_idem", { CallStatus: "completed", CallDuration: "35", SequenceNumber: "4" });
      expect(await (await twilioPost("status", completedForm)).json()).toEqual({ result: "applied" });
      expect(await (await twilioPost("status", completedForm)).json()).toEqual({ result: "duplicate" });
      // A late "ringing" arrives after the call ended: ignored, nothing moves backwards.
      const late = await twilioPost("status", inboundForm("CA_idem", { CallStatus: "ringing", SequenceNumber: "1" }));
      expect(await late.json()).toEqual({ result: "ignored" });

      expect(await prisma.usageLedgerEntry.count({ where: { conversationId, metric: "VOICE_SECONDS" } })).toBe(1);
      expect(await prisma.usageLedgerEntry.count({ where: { conversationId, metric: "TELEPHONY_SECONDS" } })).toBe(1);
      expect(await prisma.usageEvent.count({ where: { conversationId, type: "SESSION_ENDED" } })).toBe(1);
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).providerStatus).toBe("completed");
      expect(await prisma.telephonyWebhookEvent.count({ where: { status: "IGNORED", note: "out_of_order" } })).toBe(1);
    });

    it("settles from the status callback when the Dial action never arrives", async () => {
      await seedPhoneOrganization("status-only");
      const { conversationId } = await connectInboundCall("CA_status_only");
      await twilioPost("status", inboundForm("CA_status_only", { CallStatus: "completed", CallDuration: "61", SequenceNumber: "2" }));

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.status).toBe("COMPLETED");
      expect(conversation.closeReason).toBe("call_ended");
      expect((await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId, metric: "VOICE_SECONDS" } })).source).toBe(
        "server_clock"
      );
    });
  });

  describe("authentication", () => {
    it("refuses unsigned, mis-signed or foreign-account Twilio requests before touching anything", async () => {
      await seedPhoneOrganization("auth");
      expect((await twilioPost("voice", inboundForm("CA_bad"), { signature: "AAAA" })).status).toBe(403);
      // Signed for a different host than our configured origin (a forged Host header can't help).
      expect((await twilioPost("voice", inboundForm("CA_bad"), { signedUrlBase: "https://evil.example" })).status).toBe(403);
      expect((await twilioPost("voice", inboundForm("CA_bad", { AccountSid: `AC${"1".repeat(32)}` }))).status).toBe(403);
      expect((await twilioPost("unknown-event", inboundForm("CA_bad"))).status).toBe(404);
      expect(
        (await twilioPost("ai-dial-result", inboundForm("CA_bad"), { query: "?conversation=not-a-uuid" })).status
      ).toBe(400);
      expect(await prisma.conversation.count()).toBe(0);

      delete process.env.TWILIO_AUTH_TOKEN;
      expect((await twilioPost("voice", inboundForm("CA_bad"))).status).toBe(503);
    });

    it("refuses bad OpenAI signatures and rejects SIP calls we didn't set up", async () => {
      await seedPhoneOrganization("sip-auth");
      expect((await openaiPost({ callId: "rtc_x", conversationId: randomUUID(), badSignature: true })).response.status).toBe(400);

      const unknown = await openaiPost({ callId: "rtc_unknown", conversationId: randomUUID() });
      expect(await unknown.response.json()).toEqual({ result: "rejected" });
      const missingHeader = await openaiPost({ callId: "rtc_noheader", conversationId: null });
      expect(await missingHeader.response.json()).toEqual({ result: "rejected" });
      expect(mocks.callControl.reject).toHaveBeenCalledTimes(2);
      expect(mocks.callControl.accept).not.toHaveBeenCalled();

      // A call set up more than two minutes ago can no longer be claimed.
      const voice = await twilioPost("voice", inboundForm("CA_stale"));
      const conversationId = conversationIdFrom(await voice.text());
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { startedAt: new Date(Date.now() - 3 * 60 * 1000) },
      });
      expect(await (await openaiPost({ callId: "rtc_stale", conversationId })).response.json()).toEqual({ result: "rejected" });

      delete process.env.OPENAI_WEBHOOK_SECRET;
      expect((await openaiPost({ callId: "rtc_y", conversationId })).response.status).toBe(503);
    });
  });

  describe("failure recovery", () => {
    it("sends callers to the transfer line when there's no plan, and says 'not in service' for unknown numbers", async () => {
      const { organization } = await seedPhoneOrganization("no-plan");
      // No subscription, and past the automatic trial: no plan at all.
      await prisma.subscription.deleteMany({ where: { organizationId: organization.id } });
      await prisma.organization.update({
        where: { id: organization.id },
        data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
      });

      const xml = await (await twilioPost("voice", inboundForm("CA_noplan"))).text();
      expect(xml).toContain(`>${TRANSFER_NUMBER}</Dial>`);
      expect(xml).toContain(`callerId="${CALLER}"`);
      expect(xml).not.toContain("sip:");
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.telephonyWebhookEvent.findFirstOrThrow({ where: { eventKey: "CA_noplan:voice" } })).toMatchObject({
        status: "IGNORED",
        note: "quota_no_plan",
      });

      const unknown = await (await twilioPost("voice", inboundForm("CA_unknown", { To: "+233302999999" }))).text();
      expect(unknown).toContain("not in service");
      expect(unknown).toContain("<Hangup/>");
    });

    it("apologises when the AI isn't configured and there is no transfer line", async () => {
      await seedPhoneOrganization("no-ai", { transferNumber: null });
      delete process.env.OPENAI_API_KEY;
      const xml = await (await twilioPost("voice", inboundForm("CA_noai"))).text();
      expect(xml).toContain("take your call right now");
      expect(xml).toContain("<Hangup/>");
    });

    it("fails the conversation without billing when the AI leg never connects, then falls back", async () => {
      await seedPhoneOrganization("leg-fail");
      const conversationId = conversationIdFrom(await (await twilioPost("voice", inboundForm("CA_legfail"))).text());

      const dial = await twilioPost("ai-dial-result", inboundForm("CA_legfail", { DialCallStatus: "failed" }), {
        query: `?conversation=${conversationId}`,
      });
      expect(await dial.text()).toContain(`>${TRANSFER_NUMBER}</Dial>`);
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        status: "FAILED",
        outcome: "FAILED",
      });
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).failureReason).toBe("ai_leg_failed");
      expect(await prisma.usageLedgerEntry.count({ where: { conversationId } })).toBe(0);
    });

    it("marks the conversation failed when OpenAI refuses the accept", async () => {
      await seedPhoneOrganization("accept-fail");
      mocks.callControl.accept.mockRejectedValueOnce(new Error("401 Incorrect API key provided: sk-proj********abcd."));
      const conversationId = conversationIdFrom(await (await twilioPost("voice", inboundForm("CA_acceptfail"))).text());

      const { response } = await openaiPost({ callId: "rtc_acceptfail", conversationId });
      expect(await response.json()).toEqual({ result: "failed" });
      expect(mocks.afterTasks).toHaveLength(0);
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        status: "FAILED",
        closeReason: "ai_accept_failed",
        errorMessage: "401 Incorrect API key provided: [redacted-key].",
      });
      expect(await prisma.usageLedgerEntry.count({ where: { conversationId } })).toBe(0);
    });

    it("ignores a Dial action whose CallSid doesn't match the conversation in the URL", async () => {
      await seedPhoneOrganization("mismatch");
      const { conversationId } = await connectInboundCall("CA_real");
      const response = await twilioPost(
        "ai-dial-result",
        inboundForm("CA_someone_else", { DialCallStatus: "completed", DialCallDuration: "10" }),
        { query: `?conversation=${conversationId}` }
      );
      expect(await response.text()).toContain("<Hangup/>");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).status).toBe("ACTIVE");
    });
  });

  describe("tools, transfer and handoff", () => {
    it("transfers to a person, settles as TRANSFERRED, and records whether anyone answered", async () => {
      await seedPhoneOrganization("transfer");
      const { conversationId } = await connectInboundCall("CA_transfer");
      const carrier = fakeCarrier();

      const result = await executePhoneTool({ conversationId, name: "transfer_to_human", argumentsJson: '{"reason":"billing"}', carrier });
      expect(result).toMatchObject({ transferred: true });
      expect(carrier.redirectCall).toHaveBeenCalledTimes(1);
      const [callSid, twiml] = carrier.redirectCall.mock.calls[0] as unknown as [string, string];
      expect(callSid).toBe("CA_transfer");
      expect(twiml).toContain(`>${TRANSFER_NUMBER}</Dial>`);
      expect(twiml).toContain(`transfer-result?conversation=${conversationId}`);
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        status: "COMPLETED",
        outcome: "TRANSFERRED",
      });

      // A second transfer request (the model repeating itself) can't redirect the call again.
      const again = await executePhoneTool({ conversationId, name: "transfer_to_human", argumentsJson: "{}", carrier });
      expect(again.output).toContain("no longer active");
      expect(carrier.redirectCall).toHaveBeenCalledTimes(1);

      const missed = await twilioPost("transfer-result", inboundForm("CA_transfer", { DialCallStatus: "no-answer" }), {
        query: `?conversation=${conversationId}`,
      });
      expect(await missed.text()).toContain("no one is available");
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).transferStatus).toBe("MISSED");
    });

    it("rolls a failed transfer back so the AI can take a message instead", async () => {
      await seedPhoneOrganization("transfer-fail");
      const { conversationId } = await connectInboundCall("CA_transfer_fail");
      const carrier = fakeCarrier();
      carrier.redirectCall.mockRejectedValueOnce(new Error("Twilio 500"));

      const result = await executePhoneTool({ conversationId, name: "transfer_to_human", argumentsJson: "{}", carrier });
      expect(result.output).toContain("take a message");
      expect(result.transferred).toBeUndefined();
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).transferStatus).toBeNull();
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).status).toBe("ACTIVE");
      expect(await prisma.usageEvent.count({ where: { conversationId, type: "ERROR" } })).toBe(1);
    });

    it("saves contact details, records opt-outs, and validates model arguments", async () => {
      const { organization } = await seedPhoneOrganization("tools");
      const { conversationId } = await connectInboundCall("CA_tools");

      const saved = await executePhoneTool({
        conversationId,
        name: "save_contact_details",
        argumentsJson: JSON.stringify({ name: "Ama", use_caller_number: true, note: "Wants a quote" }),
      });
      expect(saved.output).toBe('{"ok":true}');
      expect(await prisma.lead.findFirstOrThrow({ where: { conversationId } })).toMatchObject({ name: "Ama", phone: CALLER });

      const badEmail = await executePhoneTool({
        conversationId,
        name: "save_contact_details",
        argumentsJson: JSON.stringify({ name: "Kojo", email: "kojo-at-example" }),
      });
      expect(badEmail.output).toContain("doesn't look right");
      const badPhone = await executePhoneTool({
        conversationId,
        name: "save_contact_details",
        argumentsJson: JSON.stringify({ phone: "12" }),
      });
      expect(badPhone.output).toContain("doesn't look complete");

      const optOut = await executePhoneTool({ conversationId, name: "opt_out_of_calls", argumentsJson: "" });
      expect(optOut.output).toContain('"ok":true');
      expect(await prisma.callOptOut.findFirstOrThrow({ where: { organizationId: organization.id } })).toMatchObject({
        phoneNumber: CALLER,
        source: "CALLER_REQUEST",
      });

      const embeddingProvider = { embedMany: async (texts: string[]) => texts.map(() => new Array(1536).fill(0)) };
      const search = await executePhoneTool({
        conversationId,
        name: "search_knowledge",
        argumentsJson: '{"query":"opening hours"}',
        embeddingProvider,
      });
      expect(JSON.parse(search.output)).toEqual({ results: [] });
      expect((await executePhoneTool({ conversationId, name: "search_knowledge", argumentsJson: "{" })).output).toContain(
        "search query"
      );
      expect(await executePhoneTool({ conversationId, name: "end_call", argumentsJson: "" })).toMatchObject({ endCall: true });
      expect((await executePhoneTool({ conversationId, name: "drop_tables", argumentsJson: "" })).output).toContain("Unknown tool");
      expect((await executePhoneTool({ conversationId: randomUUID(), name: "end_call", argumentsJson: "" })).output).toContain(
        "not active"
      );
    });

    it("keeps TRANSFERRED when a lead arrives after the transfer", async () => {
      await seedPhoneOrganization("transfer-lead");
      const { conversationId } = await connectInboundCall("CA_transfer_lead");
      await executePhoneTool({ conversationId, name: "transfer_to_human", argumentsJson: "{}", carrier: fakeCarrier() });
      await executePhoneTool({
        conversationId,
        name: "save_contact_details",
        argumentsJson: JSON.stringify({ name: "Late lead", use_caller_number: true }),
      });
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).outcome).toBe("TRANSFERRED");
    });
  });

  describe("sideband control connection", () => {
    function fakeConnection() {
      const listeners: { open?: () => void; event?: (event: SidebandServerEvent) => void; close?: () => void } = {};
      const sent: Array<Record<string, unknown>> = [];
      return {
        sent,
        emit: (event: SidebandServerEvent) => listeners.event?.(event),
        open: () => listeners.open?.(),
        connection: {
          send: (event: Record<string, unknown>) => {
            sent.push(event);
          },
          close: () => {
            listeners.close?.();
          },
          onOpen: (listener: () => void) => {
            listeners.open = listener;
          },
          onEvent: (listener: (event: SidebandServerEvent) => void) => {
            listeners.event = listener;
          },
          onClose: (listener: () => void) => {
            listeners.close = listener;
          },
        },
      };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    it("greets, answers tool calls, and hangs up when the AI ends the call", async () => {
      await seedPhoneOrganization("sideband");
      const { conversationId, callId } = await connectInboundCall("CA_sideband");
      const fake = fakeConnection();
      const executeTool = vi.fn(async ({ name }: { name: string }) =>
        name === "end_call" ? { output: '{"ok":true}', endCall: true } : { output: '{"results":["Open 8-6"]}' }
      );
      const running = runSideband({
        conversationId,
        callId,
        connection: fake.connection,
        maxSeconds: 270,
        deps: { executeTool, callControl: mocks.callControl, sleep: async () => undefined },
      });

      fake.open();
      expect(fake.sent[0]).toEqual({ type: "response.create" });
      fake.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "search_knowledge", arguments: '{"query":"hours"}' });
      await settle();
      expect(fake.sent.slice(1)).toEqual([
        { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: '{"results":["Open 8-6"]}' } },
        { type: "response.create" },
      ]);
      fake.emit({ type: "error", error: { message: "rate limited" } });
      fake.emit({ type: "response.function_call_arguments.done", call_id: "c2", name: "end_call", arguments: "" });
      await running;
      expect(mocks.callControl.hangup).toHaveBeenCalledWith(callId);
      expect(executeTool).toHaveBeenCalledTimes(2);
      await settle();
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { conversationId, type: "ERROR" } })).toMatchObject({
        metadata: { stage: "sideband", message: "rate limited" },
      });
    });

    it("closes after a transfer and reports a failing tool to the model instead of crashing", async () => {
      await seedPhoneOrganization("sideband-2");
      const { conversationId, callId } = await connectInboundCall("CA_sideband_2");
      const fake = fakeConnection();
      const executeTool = vi
        .fn()
        .mockRejectedValueOnce(new Error("database down"))
        .mockResolvedValueOnce({ output: '{"ok":true}', transferred: true });
      const running = runSideband({
        conversationId,
        callId,
        connection: fake.connection,
        maxSeconds: 270,
        deps: { executeTool, callControl: mocks.callControl, sleep: async () => undefined },
      });
      fake.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "search_knowledge", arguments: "{}" });
      await settle();
      expect(fake.sent).toContainEqual({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "c1", output: '{"error":"Tool failed."}' },
      });
      fake.emit({ type: "response.function_call_arguments.done", call_id: "c2", name: "transfer_to_human", arguments: "{}" });
      await running;
      expect(mocks.callControl.hangup).not.toHaveBeenCalled();
    });
  });

  describe("usage reconciliation", () => {
    it("fills in carrier usage for a lost callback, stores prices, and reports duration mismatches", async () => {
      const { organization } = await seedPhoneOrganization("reconcile");
      const lost = await connectInboundCall("CA_lost");
      await twilioPost("ai-dial-result", inboundForm("CA_lost", { DialCallStatus: "completed", DialCallDuration: "80" }), {
        query: `?conversation=${lost.conversationId}`,
      });
      const mismatch = await connectInboundCall("CA_mismatch");
      await twilioPost("status", inboundForm("CA_mismatch", { CallStatus: "completed", CallDuration: "102", SequenceNumber: "2" }));
      await connectInboundCall("CA_live");

      const later = new Date(Date.now() + 60 * 60 * 1000);
      const carrier = fakeCarrier();
      carrier.fetchCall.mockImplementation(async (sid: string) =>
        sid === "CA_live"
          ? { status: "in-progress", durationSeconds: null, priceMicros: null, priceUnit: null }
          : { status: "completed", durationSeconds: 100, priceMicros: 13_000, priceUnit: "USD" }
      );

      const result = await reconcileTelephonyCalls({ now: later, carrier });
      expect(result).toMatchObject({ checked: 3, reconciled: 2, recoveredCarrierUsage: 1, stillInProgress: 1, fetchFailures: 0 });
      expect(result.mismatches).toEqual([
        { conversationId: mismatch.conversationId, organizationId: organization.id, callbackSeconds: 102, carrierSeconds: 100 },
      ]);
      expect(await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId: lost.conversationId } })).toMatchObject({
        carrierSeconds: 100,
        carrierPriceMicros: 13_000,
        carrierPriceUnit: "USD",
        providerStatus: "completed",
      });
      expect(
        await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId: lost.conversationId, metric: "TELEPHONY_SECONDS" } })
      ).toMatchObject({ quantity: 100, source: "provider_reconciliation" });
      // The callback's own figure stays on the record and in the ledger; the mismatch is reported, not overwritten.
      expect(
        (await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId: mismatch.conversationId, metric: "TELEPHONY_SECONDS" } }))
          .quantity
      ).toBe(102);

      // Idempotent: a second run only re-checks the call that was still in progress.
      const again = await reconcileTelephonyCalls({ now: later, carrier });
      expect(again).toMatchObject({ checked: 1, reconciled: 0, stillInProgress: 1 });

      carrier.fetchCall.mockRejectedValueOnce(new Error("Twilio down"));
      expect(await reconcileTelephonyCalls({ now: later, carrier })).toMatchObject({ fetchFailures: 1 });

      const report = await getTelephonyReconciliationReport(new Date(Date.now() - 60 * 60 * 1000));
      expect(report).toEqual([
        expect.objectContaining({
          organizationId: organization.id,
          calls: 3,
          unreconciled: 1,
          aiBilledSeconds: 80,
          aiLegSeconds: 80,
          carrierLedgerSeconds: 202,
          carrierSeconds: 202,
          carrierPriceMicros: 26_000,
        }),
      ]);
    });

    it("runs as a protected cron job and skips cleanly without Twilio", async () => {
      const request = (secret?: string) =>
        new NextRequest("http://localhost/api/cron/reconcile-telephony", {
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
        });
      delete process.env.CRON_SECRET;
      expect((await reconcileRoute(request("x"))).status).toBe(503);
      process.env.CRON_SECRET = "cron-test-secret";
      expect((await reconcileRoute(request("wrong"))).status).toBe(401);
      delete process.env.TWILIO_ACCOUNT_SID;
      const response = await reconcileRoute(request("cron-test-secret"));
      expect(await response.json()).toEqual({ skipped: "Twilio is not configured." });
      expect(await prisma.jobRun.findFirstOrThrow({ where: { job: "reconcile-telephony" } })).toMatchObject({ status: "SUCCEEDED" });
    });
  });
});
