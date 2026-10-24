import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { TenantAccessError } from "@/server/auth/tenant";
import { resetDatabase, seedVoiceOrganization } from "./helpers";

type Role = "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST";
type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: Role;
  membershipId: string;
};

const mocks = vi.hoisted(() => ({
  context: null as MockContext | null,
  carrier: {
    createCall: vi.fn(async () => ({ callSid: "CA_outbound" })),
    redirectCall: vi.fn(async () => undefined),
    fetchCall: vi.fn(),
  },
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async (slug: string) => {
    if (!mocks.context) throw new TenantAccessError("You must be signed in.", 401);
    if (mocks.context.organization.slug !== slug) throw new TenantAccessError("You do not have access to this organization.", 403);
    return mocks.context;
  }),
  requireCurrentUser: vi.fn(async () => {
    if (!mocks.context) throw new TenantAccessError("You must be signed in.", 401);
    return mocks.context.user;
  }),
}));
vi.mock("@/server/telephony/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/telephony/twilio")>()),
  getTelephonyCarrier: () => mocks.carrier,
}));

const { placeOutboundCall, OutboundCallError } = await import("@/server/telephony/outbound");
const actions = await import("@/server/actions/phone");
const { eraseContact } = await import("@/server/actions/privacy");
const { applyRetention } = await import("@/server/privacy/retention");
const { getPhoneOverview } = await import("@/server/telephony/queries");
const { POST: twilioRoute } = await import("@/app/api/telephony/twilio/[event]/route");

const BASE_URL = "https://voice.example.com";
const ACCOUNT_SID = `AC${"0".repeat(32)}`;
const AUTH_TOKEN = "test-auth-token";
const OUR_NUMBER = "+233302000001";
const PERSON = "+233245550000";
/** Inside Ghana calling hours on the day the tests run. */
const NOON = new Date();
NOON.setUTCHours(12, 0, 0, 0);

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_PROJECT_ID",
  "NEXTAUTH_URL",
  "TELEPHONY_OUTBOUND_CALLING_CODES",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setPhoneEnv() {
  process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_WEBHOOK_SECRET = "whsec_dGVzdA==";
  process.env.OPENAI_PROJECT_ID = "proj_test";
  process.env.NEXTAUTH_URL = BASE_URL;
  delete process.env.TELEPHONY_OUTBOUND_CALLING_CODES;
}

async function twilioPost(event: string, form: Record<string, string>, query = "") {
  const path = `/api/telephony/twilio/${event}${query}`;
  const data = Object.keys(form)
    .sort()
    .reduce((acc, key) => acc + key + form[key], `${BASE_URL}${path}`);
  const signature = createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
  return twilioRoute(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      body: new URLSearchParams(form).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    }),
    { params: Promise.resolve({ event }) }
  );
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function seed(slug: string, role: Role = "OWNER", numberData: Partial<{ outboundEnabled: boolean; agentId: string | null }> = {}) {
  const seeded = await seedVoiceOrganization(slug, { publish: true, leadCapture: true, planFrom: NOON });
  const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}@${slug}.example`, name: role, passwordHash: "x" } });
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: seeded.organization.id, role },
  });
  const phoneNumber = await prisma.phoneNumber.create({
    data: {
      organizationId: seeded.organization.id,
      agentId: numberData.agentId === undefined ? seeded.agent.id : numberData.agentId,
      e164: `+2333020${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
      outboundEnabled: numberData.outboundEnabled ?? true,
    },
  });
  mocks.context = { user, organization: seeded.organization, role, membershipId: membership.id };
  return { ...seeded, user, phoneNumber };
}

async function place(
  setup: Awaited<ReturnType<typeof seed>>,
  overrides: Partial<Parameters<typeof placeOutboundCall>[0]> = {}
) {
  return placeOutboundCall({
    organizationId: setup.organization.id,
    userId: setup.user.id,
    phoneNumberId: setup.phoneNumber.id,
    destination: PERSON,
    requestConfirmed: true,
    carrier: mocks.carrier,
    now: NOON,
    ...overrides,
  });
}

describe("outbound calling and phone controls", () => {
  beforeEach(async () => {
    await resetDatabase();
    setPhoneEnv();
    mocks.context = null;
    mocks.carrier.createCall.mockReset().mockImplementation(async () => ({ callSid: `CA${randomUUID().replace(/-/g, "")}` }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  describe("authorized outbound calls", () => {
    it("places a confirmed call through the carrier with a hard time limit and an audit entry", async () => {
      const setup = await seed("outbound");
      const { conversationId } = await place(setup);

      expect(mocks.carrier.createCall).toHaveBeenCalledWith({
        to: PERSON,
        from: setup.phoneNumber.e164,
        answerUrl: `${BASE_URL}/api/telephony/twilio/outbound-answer?conversation=${conversationId}`,
        statusCallbackUrl: `${BASE_URL}/api/telephony/twilio/status`,
        ringTimeoutSeconds: 30,
        timeLimitSeconds: 270 + 60,
      });
      const call = await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId }, include: { conversation: true } });
      expect(call).toMatchObject({ direction: "OUTBOUND", remoteNumber: PERSON, requestedByUserId: setup.user.id });
      expect(call.providerCallSid).toMatch(/^CA/);
      expect(call.conversation).toMatchObject({ channel: "PHONE", status: "ACTIVE", reservedSeconds: 270 });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "phone.outbound_call_placed" } });
      expect(audit.metadata).toMatchObject({ basis: "confirmed_request", destination: "+233 ••• ••• 000" });
      expect(JSON.stringify(audit.metadata)).not.toContain(PERSON);
    });

    it("accepts a lead's own number as the basis, and refuses any other number for that lead", async () => {
      const setup = await seed("lead-basis");
      const lead = await prisma.lead.create({
        data: { organizationId: setup.organization.id, agentId: setup.agent.id, name: "Ama", phone: "024 555 0000" },
      });
      await expect(place(setup, { leadId: lead.id, destination: "+233249999999", requestConfirmed: false })).rejects.toThrow(
        "doesn't have this phone number"
      );
      await place(setup, { leadId: lead.id, requestConfirmed: false });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "phone.outbound_call_placed" } });
      expect(audit.metadata).toMatchObject({ basis: "lead", leadId: lead.id });
    });

    it.each([
      ["no lead and no confirmation", { requestConfirmed: false }, "asked to be called"],
      ["outside calling hours", { now: new Date(new Date(NOON).setUTCHours(21)) }, "08:00 and 20:00"],
      ["another country", { destination: "+14155550100" }, "aren't enabled"],
      ["an invalid number", { destination: "12" }, "valid phone number"],
    ])("refuses %s", async (_label, overrides, message) => {
      const setup = await seed("refuse");
      await expect(place(setup, overrides)).rejects.toThrow(message);
      expect(mocks.carrier.createCall).not.toHaveBeenCalled();
      expect(await prisma.conversation.count()).toBe(0);
    });

    it("refuses numbers with outbound off, no agent, or its own number", async () => {
      const off = await seed("off", "OWNER", { outboundEnabled: false });
      await expect(place(off)).rejects.toThrow("turned off");
      const noAgent = await seed("no-agent", "OWNER", { agentId: null });
      await expect(place(noAgent)).rejects.toThrow("published agent");
      const self = await seed("self");
      await expect(place(self, { destination: self.phoneNumber.e164 })).rejects.toThrow("can't call itself");
    });

    it("never calls a number on the do-not-call list, and leaves nothing behind", async () => {
      const setup = await seed("dnc");
      await prisma.callOptOut.create({ data: { organizationId: setup.organization.id, phoneNumber: PERSON, source: "STAFF" } });
      await expect(place(setup)).rejects.toThrow("do-not-call");
      expect(await prisma.conversation.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "phone.outbound_call_placed" } })).toBe(0);
    });

    it("enforces the repeat cooldown and the hourly limit", async () => {
      const setup = await seed("limits");
      await place(setup);
      await expect(place(setup)).rejects.toThrow("last 10 minutes");

      // Fill the hour with other numbers (marking each finished so the concurrency cap doesn't trip first).
      await prisma.conversation.updateMany({ data: { status: "COMPLETED" } });
      for (let index = 1; index < 20; index += 1) {
        await place(setup, { destination: `+23324000${String(index).padStart(4, "0")}` });
        await prisma.conversation.updateMany({ where: { status: "ACTIVE" }, data: { status: "COMPLETED" } });
      }
      await expect(place(setup, { destination: "+233249990000" })).rejects.toThrow("20 calls an hour");
    });

    it("fails the conversation and frees the reservation when the carrier refuses the call", async () => {
      const setup = await seed("carrier-fail");
      mocks.carrier.createCall.mockRejectedValueOnce(new Error("Twilio 21215: geo permission"));
      await expect(place(setup)).rejects.toThrow("couldn't be placed");
      const conversation = await prisma.conversation.findFirstOrThrow({ include: { phoneCall: true } });
      expect(conversation).toMatchObject({ status: "FAILED", outcome: "FAILED", closeReason: "carrier_create_failed" });
      expect(conversation.phoneCall).toMatchObject({ providerStatus: "failed", failureReason: "carrier_create_failed" });
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    });

    it("refuses when telephony isn't configured or the plan has no minutes", async () => {
      const setup = await seed("blocked");
      delete process.env.TWILIO_AUTH_TOKEN;
      await expect(place(setup)).rejects.toThrow(OutboundCallError);
      setPhoneEnv();
      await prisma.subscription.deleteMany({ where: { organizationId: setup.organization.id } });
      await prisma.organization.update({
        where: { id: setup.organization.id },
        data: { createdAt: new Date(NOON.getTime() - 60 * 24 * 60 * 60 * 1000) },
      });
      await expect(place(setup)).rejects.toThrow("no active plan");
    });
  });

  describe("outbound call webhooks", () => {
    function callForm(callSid: string, extra: Record<string, string> = {}) {
      return { AccountSid: ACCOUNT_SID, CallSid: callSid, From: OUR_NUMBER, To: PERSON, Direction: "outbound-api", ...extra };
    }

    it("lets the person press 9 to stop future calls before the AI joins", async () => {
      const setup = await seed("keypad");
      const { conversationId } = await place(setup);
      const callSid = (await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).providerCallSid as string;

      const answer = await twilioPost("outbound-answer", callForm(callSid, { CallStatus: "in-progress", AnsweredBy: "human" }), `?conversation=${conversationId}`);
      const xml = await answer.text();
      expect(xml).toContain("press 9");
      expect(xml).toContain(`outbound-keypad?conversation=${conversationId}`);

      const keypad = await twilioPost("outbound-keypad", callForm(callSid, { Digits: "9" }), `?conversation=${conversationId}`);
      expect(await keypad.text()).toContain("won't receive further calls");
      expect(await prisma.callOptOut.findFirstOrThrow({ where: { organizationId: setup.organization.id } })).toMatchObject({
        phoneNumber: PERSON,
        source: "CALLER_KEYPAD",
      });
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({
        status: "COMPLETED",
        outcome: "NOT_CONNECTED",
        closeReason: "opted_out",
      });
      // And the next attempt is refused.
      await prisma.phoneCall.updateMany({ data: { createdAt: new Date(NOON.getTime() - 60 * 60 * 1000) } });
      await expect(place(setup)).rejects.toThrow("do-not-call");
    });

    it("connects the AI when no key is pressed, and binds an answer that beats the stored CallSid", async () => {
      const setup = await seed("connect");
      mocks.carrier.createCall.mockRejectedValueOnce(new Error("timeout"));
      await expect(place(setup)).rejects.toThrow();
      await prisma.conversation.deleteMany();

      const { conversationId } = await place(setup, { destination: "+233245550001" });
      await prisma.phoneCall.updateMany({ where: { conversationId }, data: { providerCallSid: null } });
      const answer = await twilioPost("outbound-answer", callForm("CA_early", { AnsweredBy: "unknown" }), `?conversation=${conversationId}`);
      expect(await answer.text()).toContain("press 9");
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).providerCallSid).toBe("CA_early");

      const keypad = await twilioPost("outbound-keypad", callForm("CA_early", { Digits: "" }), `?conversation=${conversationId}`);
      const xml = await keypad.text();
      expect(xml).toContain(`X-Sunleon-Conversation=${conversationId}`);
      expect(xml).not.toContain("You've reached");
    });

    it("hangs up on answering machines and settles unanswered calls without billing", async () => {
      const setup = await seed("machine");
      const machine = await place(setup);
      const machineSid = (await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId: machine.conversationId } }))
        .providerCallSid as string;
      const answer = await twilioPost(
        "outbound-answer",
        callForm(machineSid, { AnsweredBy: "machine_start" }),
        `?conversation=${machine.conversationId}`
      );
      expect(await answer.text()).toContain("<Hangup/>");
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: machine.conversationId } })).toMatchObject({
        outcome: "NOT_CONNECTED",
        closeReason: "answering_machine",
      });

      const unanswered = await place(setup, { destination: "+233245550002" });
      const sid = (await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId: unanswered.conversationId } }))
        .providerCallSid as string;
      await twilioPost("status", callForm(sid, { CallStatus: "no-answer", CallDuration: "0", SequenceNumber: "2" }));
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: unanswered.conversationId } })).toMatchObject({
        status: "COMPLETED",
        outcome: "NOT_CONNECTED",
        closeReason: "call_no-answer",
      });
      expect(await prisma.usageLedgerEntry.count()).toBe(0);
    });
  });

  describe("phone actions", () => {
    it("lets owners and admins configure a number, scoped to their organization", async () => {
      const theirs = await seed("theirs");
      const mine = await seed("mine", "ADMIN");

      const settings = { agentId: mine.agent.id, transferNumber: "024 111 2222", inboundEnabled: "on", outboundEnabled: "on" };
      expect(await actions.updatePhoneNumberSettings("mine", theirs.phoneNumber.id, form(settings))).toEqual({
        ok: false,
        error: "Phone number not found.",
      });
      expect(await actions.updatePhoneNumberSettings("mine", mine.phoneNumber.id, form({ ...settings, agentId: theirs.agent.id }))).toEqual({
        ok: false,
        error: "Agent not found.",
      });
      expect(
        await actions.updatePhoneNumberSettings("mine", mine.phoneNumber.id, form({ ...settings, transferNumber: mine.phoneNumber.e164 }))
      ).toMatchObject({ ok: false });
      expect(await actions.updatePhoneNumberSettings("mine", mine.phoneNumber.id, form(settings))).toEqual({
        ok: true,
        message: "Phone settings saved.",
      });
      expect(await prisma.phoneNumber.findUniqueOrThrow({ where: { id: mine.phoneNumber.id } })).toMatchObject({
        transferNumber: "+233241112222",
        outboundEnabled: true,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "phone.number_updated" } });
      expect(audit.metadata).toMatchObject({ transferNumber: "+233 ••• ••• 222" });

      const unpublished = await prisma.agent.create({ data: { organizationId: mine.organization.id, name: "Draft" } });
      expect(
        await actions.updatePhoneNumberSettings("mine", mine.phoneNumber.id, form({ ...settings, agentId: unpublished.id }))
      ).toEqual({ ok: false, error: "Publish the agent before it can answer calls." });

      mocks.context = { ...mocks.context!, role: "AGENT_MANAGER" };
      await expect(actions.updatePhoneNumberSettings("mine", mine.phoneNumber.id, form(settings))).rejects.toThrow(TenantAccessError);
    });

    it("lets agent managers place calls but not analysts", async () => {
      const setup = await seed("call-roles", "ANALYST");
      const fields = { phoneNumberId: setup.phoneNumber.id, leadId: "", destination: PERSON, requestConfirmed: "on" };
      await expect(actions.startOutboundCall("call-roles", form(fields))).rejects.toThrow(TenantAccessError);

      mocks.context = { ...mocks.context!, role: "AGENT_MANAGER" };
      expect(await actions.startOutboundCall("call-roles", form({ ...fields, requestConfirmed: "" }))).toEqual({
        ok: false,
        error: "Confirm that this person asked to be called.",
      });
      expect(await actions.startOutboundCall("call-roles", form(fields))).toMatchObject({ ok: true });
      expect(mocks.carrier.createCall).toHaveBeenCalledTimes(1);

      const noPhone = await prisma.lead.create({
        data: { organizationId: setup.organization.id, agentId: setup.agent.id, name: "No phone", email: "a@b.example" },
      });
      expect(await actions.startOutboundCall("call-roles", form({ ...fields, leadId: noPhone.id }))).toEqual({
        ok: false,
        error: "That lead has no phone number.",
      });
    });

    it("adds to the do-not-call list freely but only lets the owner remove, with confirmation", async () => {
      const setup = await seed("dnc-actions", "AGENT_MANAGER");
      expect(await actions.addOptOut("dnc-actions", form({ phoneNumber: "024 555 0000" }))).toEqual({
        ok: true,
        message: "Added to the do-not-call list.",
      });
      expect(await actions.addOptOut("dnc-actions", form({ phoneNumber: "+233245550000" }))).toMatchObject({
        message: "That number is already on the list.",
      });
      expect(await actions.addOptOut("dnc-actions", form({ phoneNumber: "nope" }))).toMatchObject({ ok: false });
      const entry = await prisma.callOptOut.findFirstOrThrow({ where: { organizationId: setup.organization.id } });

      await expect(actions.removeOptOut("dnc-actions", entry.id, form({ confirmation: "REMOVE" }))).rejects.toThrow(TenantAccessError);
      mocks.context = { ...mocks.context!, role: "OWNER" };
      expect(await actions.removeOptOut("dnc-actions", entry.id, form({ confirmation: "yes" }))).toMatchObject({ ok: false });
      expect(await actions.removeOptOut("dnc-actions", entry.id, form({ confirmation: "REMOVE" }))).toMatchObject({ ok: true });
      expect(await prisma.callOptOut.count()).toBe(0);
      const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: "phone.opt_out" } } });
      expect(audits.map((audit) => audit.action).sort()).toEqual(["phone.opt_out_added", "phone.opt_out_removed"]);
      expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain("245550000");
    });

    it("lets only platform admins register and release numbers", async () => {
      const setup = await seed("registry");
      const fields = { e164: "030 123 4567", providerNumberSid: "", organizationSlug: "registry", label: "Main" };
      await expect(actions.registerPhoneNumber(form(fields))).rejects.toThrow(TenantAccessError);

      await prisma.user.update({ where: { id: setup.user.id }, data: { isPlatformAdmin: true } });
      expect(await actions.registerPhoneNumber(form(fields))).toMatchObject({ ok: true });
      expect(await actions.registerPhoneNumber(form(fields))).toEqual({
        ok: false,
        error: "That number (or SID) is already registered.",
      });
      expect(await actions.registerPhoneNumber(form({ ...fields, e164: "+233301110000", organizationSlug: "nobody" }))).toEqual({
        ok: false,
        error: "Organization not found.",
      });
      const registered = await prisma.phoneNumber.findUniqueOrThrow({ where: { e164: "+233301234567" } });
      expect(await actions.releasePhoneNumber(registered.id)).toMatchObject({ ok: true });
      expect(await actions.releasePhoneNumber(registered.id)).toEqual({ ok: false, error: "Phone number not found." });
      expect(await prisma.auditLog.count({ where: { action: { startsWith: "admin.phone_number" } } })).toBe(2);
    });
  });

  describe("privacy", () => {
    it("erasure removes the caller's number from call records but keeps the do-not-call entry", async () => {
      const setup = await seed("erase", "ADMIN");
      const { conversationId } = await place(setup);
      await prisma.callOptOut.create({ data: { organizationId: setup.organization.id, phoneNumber: PERSON, source: "STAFF" } });

      const result = await eraseContact("erase", form({ email: "", phone: "024 555 0000" }));
      expect(result).toEqual({ ok: true, message: "Deleted 0 leads and 0 transcripts. Removed the number from 1 call record." });
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).remoteNumber).toBeNull();
      expect(await prisma.callOptOut.count()).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.contact_erased" } });
      expect(audit.metadata).toMatchObject({ callNumbersCleared: 1 });
    });

    it("retention clears old caller numbers on the lead schedule and prunes old webhook logs", async () => {
      const setup = await seed("retention");
      const { conversationId } = await place(setup);
      const old = new Date(NOON.getTime() - 400 * 24 * 60 * 60 * 1000);
      await prisma.phoneCall.updateMany({ where: { conversationId }, data: { createdAt: old } });
      await prisma.telephonyWebhookEvent.create({
        data: { source: "TWILIO", eventKey: "old", eventType: "status", status: "PROCESSED", receivedAt: old },
      });
      await prisma.telephonyWebhookEvent.create({
        data: { source: "TWILIO", eventKey: "new", eventType: "status", status: "PROCESSED" },
      });

      const result = await applyRetention(NOON);
      expect(result).toMatchObject({ callNumbersCleared: 1, telephonyEventsDeleted: 1 });
      expect((await prisma.phoneCall.findUniqueOrThrow({ where: { conversationId } })).remoteNumber).toBeNull();
      expect(await prisma.telephonyWebhookEvent.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "retention.call_numbers_cleared" } })).toBe(1);
    });
  });

  describe("phone page data", () => {
    it("is scoped to the organization and masks callers' numbers", async () => {
      const mine = await seed("overview-mine");
      await place(mine);
      const theirs = await seed("overview-theirs");
      await place(theirs, { destination: "+233245550009" });
      await prisma.callOptOut.create({ data: { organizationId: mine.organization.id, phoneNumber: "+233245551111", source: "STAFF" } });

      const overview = await getPhoneOverview(mine.organization.id, NOON);
      expect(overview.numbers.map((number) => number.id)).toEqual([mine.phoneNumber.id]);
      expect(overview.calls).toHaveLength(1);
      expect(overview.calls[0].remote).toBe("+233 ••• ••• 000");
      expect(overview.optOuts).toEqual([expect.objectContaining({ phone: "+233 ••• ••• 111", source: "STAFF" })]);
      expect(overview.readiness).toEqual({ twilio: true, realtimeSip: true, publicUrl: true });
      expect(JSON.stringify(overview.calls)).not.toContain(PERSON);
    });
  });
});
