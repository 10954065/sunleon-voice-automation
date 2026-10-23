import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import {
  endVoiceSession,
  issueVoiceToken,
  prepareEmbedVoiceSession,
  prepareTestVoiceSession,
  recordLead,
} from "@/server/voice/session";
import { createEmbedTicket } from "@/server/voice/embedTicket";
import { sweepStaleSessions } from "@/server/billing/sweeper";
import { storeTranscript, TRANSCRIPT_SUBMIT_WINDOW_MS } from "@/server/conversations/transcripts";
import { summarizeConversation, type ConversationSummarizer } from "@/server/conversations/summaries";
import { fakeVoiceProvider, resetDatabase, seedVoiceOrganization } from "./helpers";

type Seed = Awaited<ReturnType<typeof seedVoiceOrganization>>;

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const T0 = new Date("2026-10-20T10:00:00.000Z");
const seconds = (n: number) => new Date(T0.getTime() + n * 1000);

async function prepare(seed: Seed, options: { consent?: boolean; channel?: "TEST" | "EMBED"; at?: Date } = {}) {
  const at = options.at ?? T0;
  if (options.channel === "EMBED") {
    return prepareEmbedVoiceSession({
      agentId: seed.agent.id,
      ticket: createEmbedTicket({ agentId: seed.agent.id, host: "shop.example" }),
      transcriptConsent: options.consent,
      now: at,
    });
  }
  return prepareTestVoiceSession({
    organizationId: seed.organization.id,
    organizationName: seed.organization.name,
    agentId: seed.agent.id,
    transcriptConsent: options.consent,
    now: at,
  });
}

/** Prepare → token → end through the real services, as the widget would. */
async function completeCall(seed: Seed, lengthSeconds: number, options: { consent?: boolean } = {}) {
  const prepared = await prepare(seed, options);
  await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeVoiceProvider, now: T0 });
  await endVoiceSession({ conversationId: prepared.conversationId, reason: "user_ended", now: seconds(lengthSeconds) });
  return prepared;
}

async function outcomeOf(conversationId: string) {
  return (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).outcome;
}

const SAMPLE = [
  { role: "assistant", text: "Hello, welcome to Kofi Bakery. How can I help?" },
  { role: "user", text: "Do you deliver to Osu?" },
];

describe("conversation records", () => {
  beforeEach(async () => {
    await resetDatabase();
    process.env.AI_GATEWAY_API_KEY = "placeholder-for-presence-check-only";
  });

  afterEach(() => {
    if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  });

  afterAll(async () => {
    await resetDatabase();
  });

  describe("outcome classification", () => {
    it("classifies a connected call by its billed length", async () => {
      const seed = await seedVoiceOrganization("outcomes", { planFrom: T0 });
      const long = await completeCall(seed, 95);
      const short = await completeCall(seed, 8);

      expect(await outcomeOf(long.conversationId)).toBe("ENGAGED");
      expect(await outcomeOf(short.conversationId)).toBe("SHORT");
    });

    it("upgrades the outcome when a lead arrives after the call ended", async () => {
      const seed = await seedVoiceOrganization("late-lead", { planFrom: T0 });
      const call = await completeCall(seed, 60);
      expect(await outcomeOf(call.conversationId)).toBe("ENGAGED");

      await expect(recordLead({ conversationId: call.conversationId, name: "Ama", phone: "0241234567" })).resolves.toEqual({
        ok: true,
      });
      expect(await outcomeOf(call.conversationId)).toBe("LEAD_CAPTURED");
    });

    it("counts a lead captured during the call when the call settles", async () => {
      const seed = await seedVoiceOrganization("live-lead", { planFrom: T0 });
      const prepared = await prepare(seed);
      await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeVoiceProvider, now: T0 });
      await recordLead({ conversationId: prepared.conversationId, email: "ama@example.com" });
      expect(await outcomeOf(prepared.conversationId)).toBeNull();

      await endVoiceSession({ conversationId: prepared.conversationId, now: seconds(5) });
      expect(await outcomeOf(prepared.conversationId)).toBe("LEAD_CAPTURED");
    });

    it("keeps the lead cap atomic under concurrent submissions", async () => {
      const seed = await seedVoiceOrganization("lead-cap", { planFrom: T0 });
      const call = await completeCall(seed, 30);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => recordLead({ conversationId: call.conversationId, name: `Visitor ${i}` }))
      );

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(await prisma.lead.count({ where: { conversationId: call.conversationId } })).toBe(3);
    });

    it("marks sessions the sweeper closes as not connected or abandoned", async () => {
      const seed = await seedVoiceOrganization("swept", { planFrom: T0 });
      const neverStarted = await prepare(seed);
      const abandoned = await prepare(seed);
      await issueVoiceToken({ conversationId: abandoned.conversationId, provider: fakeVoiceProvider, now: T0 });

      await sweepStaleSessions({ now: seconds(60 * 60) });

      expect(await outcomeOf(neverStarted.conversationId)).toBe("NOT_CONNECTED");
      expect(await outcomeOf(abandoned.conversationId)).toBe("ABANDONED");
    });

    it("marks a failed token mint as FAILED", async () => {
      const seed = await seedVoiceOrganization("mint-fail", { planFrom: T0 });
      const prepared = await prepare(seed);
      const failing = { mintToken: async () => Promise.reject(new Error("upstream unavailable")) };

      await expect(issueVoiceToken({ conversationId: prepared.conversationId, provider: failing, now: T0 })).rejects.toThrow();
      expect(await outcomeOf(prepared.conversationId)).toBe("FAILED");
    });
  });

  describe("transcript permission", () => {
    it("records consent only when the organization stores transcripts", async () => {
      const storing = await seedVoiceOrganization("storing", { storeTranscripts: true, planFrom: T0 });
      const notStoring = await seedVoiceOrganization("not-storing", { planFrom: T0 });

      const consented = await prepare(storing, { consent: true });
      const declined = await prepare(storing, { consent: false });
      const ignored = await prepare(notStoring, { consent: true });

      expect(consented.transcriptStorage).toBe(true);
      expect(declined.transcriptStorage).toBe(false);
      expect(ignored.transcriptStorage).toBe(false);
    });

    it("stores a consented transcript once, and refuses everything else", async () => {
      const storing = await seedVoiceOrganization("store-once", { storeTranscripts: true, planFrom: T0 });
      const consented = await completeCall(storing, 40, { consent: true });
      const declined = await completeCall(storing, 40, { consent: false });

      expect(await storeTranscript({ conversationId: consented.conversationId, entries: SAMPLE, now: seconds(41) })).toBe(
        "stored"
      );
      expect(await storeTranscript({ conversationId: consented.conversationId, entries: SAMPLE, now: seconds(42) })).toBe(
        "already_stored"
      );
      expect(await storeTranscript({ conversationId: declined.conversationId, entries: SAMPLE, now: seconds(41) })).toBe(
        "not_permitted"
      );

      const stored = await prisma.conversationTranscript.findUniqueOrThrow({
        where: { conversationId: consented.conversationId },
      });
      expect(stored.organizationId).toBe(storing.organization.id);
      expect(stored.entryCount).toBe(2);
      expect(await prisma.conversationTranscript.count()).toBe(1);
    });

    it("refuses a transcript for a session that never connected, arrives too late, or is empty", async () => {
      const storing = await seedVoiceOrganization("refusals", { storeTranscripts: true, planFrom: T0 });
      const notConnected = await prepare(storing, { consent: true });
      const late = await completeCall(storing, 30, { consent: true });
      const empty = await completeCall(storing, 30, { consent: true });

      expect(await storeTranscript({ conversationId: notConnected.conversationId, entries: SAMPLE, now: T0 })).toBe(
        "not_permitted"
      );
      const tooLate = new Date(seconds(30).getTime() + TRANSCRIPT_SUBMIT_WINDOW_MS + 1000);
      expect(await storeTranscript({ conversationId: late.conversationId, entries: SAMPLE, now: tooLate })).toBe("too_late");
      expect(
        await storeTranscript({ conversationId: empty.conversationId, entries: [{ role: "system", text: "x" }], now: seconds(31) })
      ).toBe("empty");
    });

    it("stops accepting transcripts as soon as the owner turns storage off", async () => {
      const storing = await seedVoiceOrganization("turned-off", { storeTranscripts: true, planFrom: T0 });
      const call = await completeCall(storing, 30, { consent: true });
      await prisma.organization.update({ where: { id: storing.organization.id }, data: { storeTranscripts: false } });

      expect(await storeTranscript({ conversationId: call.conversationId, entries: SAMPLE, now: seconds(31) })).toBe(
        "not_permitted"
      );
    });
  });

  describe("summaries", () => {
    const fakeSummarizer: ConversationSummarizer = {
      summarize: async (entries) => ({ summary: `  Caller asked about delivery (${entries.length} turns).  `, model: "test-double" }),
    };

    it("summarises a stored transcript within its own organization only", async () => {
      const storing = await seedVoiceOrganization("summary", { storeTranscripts: true, planFrom: T0 });
      const other = await seedVoiceOrganization("summary-other", { planFrom: T0 });
      const call = await completeCall(storing, 30, { consent: true });
      await storeTranscript({ conversationId: call.conversationId, entries: SAMPLE, now: seconds(31) });

      const crossTenant = await summarizeConversation({
        organizationId: other.organization.id,
        conversationId: call.conversationId,
        summarizer: fakeSummarizer,
      });
      expect(crossTenant.ok).toBe(false);

      const result = await summarizeConversation({
        organizationId: storing.organization.id,
        conversationId: call.conversationId,
        summarizer: fakeSummarizer,
      });
      expect(result).toEqual({ ok: true, summary: "Caller asked about delivery (2 turns)." });
      const stored = await prisma.conversationTranscript.findUniqueOrThrow({ where: { conversationId: call.conversationId } });
      expect(stored.summaryModel).toBe("test-double");
    });

    it("reports BLOCKED (missing credentials) instead of pretending to summarise", async () => {
      const storing = await seedVoiceOrganization("summary-blocked", { storeTranscripts: true, planFrom: T0 });
      const call = await completeCall(storing, 30, { consent: true });
      await storeTranscript({ conversationId: call.conversationId, entries: SAMPLE, now: seconds(31) });
      delete process.env.AI_GATEWAY_API_KEY;

      const result = await summarizeConversation({ organizationId: storing.organization.id, conversationId: call.conversationId });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toMatch(/AI_GATEWAY_API_KEY is not set/);
    });

    it("explains when there is no transcript to summarise", async () => {
      const seed = await seedVoiceOrganization("summary-none", { planFrom: T0 });
      const call = await completeCall(seed, 30);

      const result = await summarizeConversation({
        organizationId: seed.organization.id,
        conversationId: call.conversationId,
        summarizer: fakeSummarizer,
      });
      expect(result).toEqual({ ok: false, error: "This conversation has no stored transcript to summarise." });
    });
  });

  it("stores the transcript sent with the end report through the public route", async () => {
    const storing = await seedVoiceOrganization("route", { storeTranscripts: true, publish: true });
    const prepared = await prepare(storing, { consent: true, channel: "EMBED", at: new Date() });
    await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeVoiceProvider });
    const { POST } = await import("@/app/api/voice/sessions/[conversationId]/end/route");
    const { NextRequest } = await import("next/server");

    const response = await POST(
      new NextRequest(`http://localhost/api/voice/sessions/${prepared.conversationId}/end`, {
        method: "POST",
        body: JSON.stringify({ reason: "user_ended", transcript: SAMPLE }),
      }),
      { params: Promise.resolve({ conversationId: prepared.conversationId }) }
    );

    expect(await response.json()).toEqual({ ok: true, transcript: "stored" });
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: prepared.conversationId },
      include: { transcript: true },
    });
    expect(conversation.status).toBe("COMPLETED");
    expect(conversation.transcript?.entryCount).toBe(2);
  });

  it("still ends the session when the transcript is malformed", async () => {
    const storing = await seedVoiceOrganization("route-bad", { storeTranscripts: true, publish: true });
    const prepared = await prepare(storing, { consent: true, channel: "EMBED", at: new Date() });
    await issueVoiceToken({ conversationId: prepared.conversationId, provider: fakeVoiceProvider });
    const { POST } = await import("@/app/api/voice/sessions/[conversationId]/end/route");
    const { NextRequest } = await import("next/server");

    const response = await POST(
      new NextRequest(`http://localhost/api/voice/sessions/${prepared.conversationId}/end`, {
        method: "POST",
        body: JSON.stringify({ reason: "user_ended", transcript: [{ role: "hacker", text: 5 }] }),
      }),
      { params: Promise.resolve({ conversationId: prepared.conversationId }) }
    );

    expect(await response.json()).toEqual({ ok: true });
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: prepared.conversationId },
      include: { transcript: true },
    });
    expect(conversation.status).toBe("COMPLETED");
    expect(conversation.transcript).toBeNull();
  });
});
