import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import {
  endVoiceSession,
  issueVoiceToken,
  prepareEmbedVoiceSession,
  prepareTestVoiceSession,
  recordLead,
  searchKnowledgeForConversation,
  VoiceSessionError,
} from "@/server/voice/session";
import { MissingVoiceCredentialsError, type RealtimeVoiceProvider } from "@/server/voice/provider";
import { createEmbedTicket } from "@/server/voice/embedTicket";
import { processKnowledgeSource } from "@/server/knowledge/pipeline";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@/server/knowledge/embeddings";
import { resetDatabase } from "./helpers";

/**
 * Test double at the provider boundary (allowed by the build brief's quality-gate rules).
 * These tests prove our session lifecycle, tenant scoping and failure handling — they are
 * NOT evidence that a live Gateway voice session works. See docs/KNOWN_LIMITATIONS.md.
 */
function fakeVoiceProvider(): RealtimeVoiceProvider & { mintToken: ReturnType<typeof vi.fn> } {
  return {
    mintToken: vi.fn(async () => ({
      token: "vcst_test_double",
      url: "wss://gateway.invalid/realtime-model?ai-model-id=openai%2Fgpt-realtime-2",
      expiresAt: 4_102_444_800,
    })),
  };
}

const fakeEmbeddingProvider: EmbeddingProvider = {
  async embedMany(texts: string[]) {
    return texts.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
      for (let i = 0; i < text.length; i += 1) {
        vector[i % EMBEDDING_DIMENSIONS] += text.charCodeAt(i) / 255;
      }
      return vector;
    });
  },
};

async function seedAgent(
  slug: string,
  options: { publish?: boolean; leadCapture?: boolean; domains?: string[] } = {}
) {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug } });
  const agent = await prisma.agent.create({
    data: { organizationId: organization.id, name: "Agent", allowedEmbedDomains: options.domains ?? [] },
  });
  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      instructions: `Instructions for ${slug}`,
      voice: "cedar",
      leadCaptureEnabled: options.leadCapture ?? false,
      publishedAt: options.publish ? new Date() : null,
    },
  });
  if (options.publish) {
    await prisma.agent.update({ where: { id: agent.id }, data: { publishedVersionId: version.id } });
  }
  return { organization, agent, version };
}

async function prepareTest(seed: Awaited<ReturnType<typeof seedAgent>>) {
  return prepareTestVoiceSession({
    organizationId: seed.organization.id,
    organizationName: seed.organization.name,
    agentId: seed.agent.id,
  });
}

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

describe("voice sessions", () => {
  beforeEach(async () => {
    await resetDatabase();
    // Only the presence check reads this; minting always goes through the injected fake.
    process.env.AI_GATEWAY_API_KEY = "placeholder-for-presence-check-only";
  });

  afterEach(() => {
    if (originalGatewayKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
    }
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("prepareTestVoiceSession", () => {
    it("refuses to prepare a session when no voice provider is configured, creating nothing", async () => {
      delete process.env.AI_GATEWAY_API_KEY;
      const seed = await seedAgent("a");

      await expect(prepareTest(seed)).rejects.toBeInstanceOf(MissingVoiceCredentialsError);
      expect(await prisma.conversation.count()).toBe(0);
    });

    it("creates an ACTIVE TEST conversation with an unguessable UUID and the version's voice", async () => {
      const seed = await seedAgent("a");

      const prepared = await prepareTest(seed);

      expect(prepared.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(prepared.sessionConfig.voice).toBe("cedar");
      expect(prepared.sessionConfig.turnDetection).toEqual({ type: "server-vad" });
      expect(prepared.sessionConfig.instructions).toContain("Org a");
      expect(prepared.sessionConfig.instructions).toContain("Instructions for a");

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: prepared.conversationId } });
      expect(conversation).toMatchObject({
        channel: "TEST",
        status: "ACTIVE",
        tokenIssuedAt: null,
        agentVersionId: seed.version.id,
        organizationId: seed.organization.id,
      });
    });

    it("tests the newest draft rather than the published version", async () => {
      const seed = await seedAgent("a", { publish: true });
      await prisma.agentVersion.create({
        data: { agentId: seed.agent.id, versionNumber: 2, instructions: "Draft-only instructions v2" },
      });

      const prepared = await prepareTest(seed);

      expect(prepared.sessionConfig.instructions).toContain("Draft-only instructions v2");
    });

    it("rejects an agent that belongs to another organization", async () => {
      const seedA = await seedAgent("a");
      const seedB = await seedAgent("b");

      await expect(
        prepareTestVoiceSession({
          organizationId: seedA.organization.id,
          organizationName: seedA.organization.name,
          agentId: seedB.agent.id,
        })
      ).rejects.toMatchObject({ status: 404 });
    });

    it("grounds instructions only in knowledge from READY sources", async () => {
      const seed = await seedAgent("a");
      const ready = await prisma.knowledgeSource.create({
        data: {
          organizationId: seed.organization.id,
          agentId: seed.agent.id,
          type: "MANUAL",
          title: "Hours",
          status: "READY",
        },
      });
      const failed = await prisma.knowledgeSource.create({
        data: {
          organizationId: seed.organization.id,
          agentId: seed.agent.id,
          type: "MANUAL",
          title: "Broken",
          status: "FAILED",
        },
      });
      await prisma.knowledgeChunk.createMany({
        data: [
          { sourceId: ready.id, organizationId: seed.organization.id, agentId: seed.agent.id, chunkIndex: 0, content: "We open at 7am." },
          { sourceId: failed.id, organizationId: seed.organization.id, agentId: seed.agent.id, chunkIndex: 0, content: "HALF-PROCESSED-CONTENT" },
        ],
      });

      const prepared = await prepareTest(seed);

      expect(prepared.sessionConfig.instructions).toContain("We open at 7am.");
      expect(prepared.sessionConfig.instructions).not.toContain("HALF-PROCESSED-CONTENT");
    });
  });

  describe("prepareEmbedVoiceSession", () => {
    it("creates an EMBED conversation for a valid ticket from an allowed site", async () => {
      const seed = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });

      const prepared = await prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket });

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: prepared.conversationId } });
      expect(conversation).toMatchObject({ channel: "EMBED", originDomain: "shop.example.com" });
    });

    it("uses the published version, never an unpublished draft", async () => {
      const seed = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });
      await prisma.agentVersion.create({
        data: { agentId: seed.agent.id, versionNumber: 2, instructions: "UNPUBLISHED DRAFT TEXT" },
      });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });

      const prepared = await prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket });

      expect(prepared.sessionConfig.instructions).toContain("Instructions for a");
      expect(prepared.sessionConfig.instructions).not.toContain("UNPUBLISHED DRAFT TEXT");
    });

    it("rejects a ticket issued for a different agent", async () => {
      const seedA = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });
      const seedB = await seedAgent("b", { publish: true, domains: ["shop.example.com"] });
      const ticketForA = createEmbedTicket({ agentId: seedA.agent.id, host: "shop.example.com" });

      await expect(
        prepareEmbedVoiceSession({ agentId: seedB.agent.id, ticket: ticketForA })
      ).rejects.toMatchObject({ status: 403 });
    });

    it("re-checks the allowlist, so removing a site revokes outstanding tickets", async () => {
      const seed = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });
      await prisma.agent.update({ where: { id: seed.agent.id }, data: { allowedEmbedDomains: [] } });

      await expect(prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket })).rejects.toMatchObject({
        status: 403,
      });
    });

    it("rejects an unpublished agent even with a valid ticket", async () => {
      const seed = await seedAgent("a", { domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });

      await expect(prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket })).rejects.toMatchObject({
        status: 404,
      });
    });

    it("rejects a forged ticket", async () => {
      const seed = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });

      await expect(
        prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket: "forged.ticket" })
      ).rejects.toBeInstanceOf(VoiceSessionError);
      expect(await prisma.conversation.count()).toBe(0);
    });
  });

  describe("issueVoiceToken", () => {
    it("mints once, returns the search_knowledge tool, and records SESSION_STARTED", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);
      const provider = fakeVoiceProvider();

      const issued = await issueVoiceToken({ conversationId, provider });

      expect(issued.token).toBe("vcst_test_double");
      expect(issued.tools.map((tool) => tool.name)).toEqual(["search_knowledge"]);
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.tokenIssuedAt).not.toBeNull();
      const events = await prisma.usageEvent.findMany({ where: { conversationId } });
      expect(events.map((event) => event.type)).toEqual(["SESSION_STARTED"]);
    });

    it("refuses a second token for the same conversation (single-use)", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);
      const provider = fakeVoiceProvider();
      await issueVoiceToken({ conversationId, provider });

      await expect(issueVoiceToken({ conversationId, provider })).rejects.toMatchObject({ status: 409 });
      expect(provider.mintToken).toHaveBeenCalledTimes(1);
    });

    it("refuses a token once the short request window has passed", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      const provider = fakeVoiceProvider();

      await expect(
        issueVoiceToken({
          conversationId,
          provider,
          now: new Date(conversation.startedAt.getTime() + 3 * 60 * 1000),
        })
      ).rejects.toMatchObject({ status: 409 });
      expect(provider.mintToken).not.toHaveBeenCalled();
    });

    it("marks the conversation FAILED and records an ERROR event when minting fails", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);
      const provider: RealtimeVoiceProvider = {
        mintToken: async () => {
          throw new Error("Gateway rejected the key");
        },
      };

      await expect(issueVoiceToken({ conversationId, provider })).rejects.toMatchObject({
        status: 502,
        message: "Gateway rejected the key",
      });

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation).toMatchObject({ status: "FAILED", closeReason: "token_mint_failed" });
      const events = await prisma.usageEvent.findMany({ where: { conversationId } });
      expect(events.map((event) => event.type)).toEqual(["ERROR"]);
    });

    it("hides provider error details from public embed visitors", async () => {
      const seed = await seedAgent("a", { publish: true, domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: seed.agent.id, host: "shop.example.com" });
      const { conversationId } = await prepareEmbedVoiceSession({ agentId: seed.agent.id, ticket });
      const provider: RealtimeVoiceProvider = {
        mintToken: async () => {
          throw new MissingVoiceCredentialsError();
        },
      };

      const error = await issueVoiceToken({ conversationId, provider }).catch((caught) => caught);

      expect(error).toBeInstanceOf(VoiceSessionError);
      expect(error.status).toBe(503);
      expect(error.message).not.toContain("AI_GATEWAY_API_KEY");
    });
  });

  describe("endVoiceSession", () => {
    it("completes the conversation and records server and client durations separately", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);
      await issueVoiceToken({ conversationId, provider: fakeVoiceProvider() });
      const started = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

      await endVoiceSession({
        conversationId,
        reason: "user_ended",
        clientReportedSeconds: 42,
        now: new Date(started.tokenIssuedAt!.getTime() + 45_000),
      });

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation).toMatchObject({ status: "COMPLETED", closeReason: "user_ended" });
      const ended = await prisma.usageEvent.findFirstOrThrow({ where: { conversationId, type: "SESSION_ENDED" } });
      expect(ended.metadata).toMatchObject({
        chargedSeconds: 45,
        usageSource: "server_clock",
        clientReportedSeconds: 42,
      });
      // The billable quantity is the server's measurement, never the client's report.
      const ledger = await prisma.usageLedgerEntry.findFirstOrThrow({ where: { conversationId } });
      expect(ledger).toMatchObject({ quantity: 45, source: "server_clock", metric: "VOICE_SECONDS" });
    });

    it("is idempotent and ignores unknown conversations", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);

      await endVoiceSession({ conversationId });
      await endVoiceSession({ conversationId });
      await endVoiceSession({ conversationId: "00000000-0000-4000-8000-000000000000" });

      expect(await prisma.usageEvent.count({ where: { conversationId, type: "SESSION_ENDED" } })).toBe(1);
    });
  });

  describe("searchKnowledgeForConversation", () => {
    it("only ever returns knowledge from the conversation's own tenant and agent", async () => {
      const seedA = await seedAgent("a");
      const seedB = await seedAgent("b");
      const sourceA = await prisma.knowledgeSource.create({
        data: { organizationId: seedA.organization.id, agentId: seedA.agent.id, type: "MANUAL", title: "A", rawContent: "Org A delivery pricing is 20 cedis." },
      });
      const sourceB = await prisma.knowledgeSource.create({
        data: { organizationId: seedB.organization.id, agentId: seedB.agent.id, type: "MANUAL", title: "B", rawContent: "Org B secret delivery pricing is 5 cedis." },
      });
      await processKnowledgeSource(sourceA.id, seedA.organization.id, fakeEmbeddingProvider);
      await processKnowledgeSource(sourceB.id, seedB.organization.id, fakeEmbeddingProvider);
      const { conversationId } = await prepareTest(seedA);
      await issueVoiceToken({ conversationId, provider: fakeVoiceProvider() });

      const result = await searchKnowledgeForConversation({
        conversationId,
        query: "delivery pricing",
        embeddingProvider: fakeEmbeddingProvider,
      });

      if (!("results" in result)) throw new Error(`expected results, got ${result.error}`);
      expect(result.results.join(" ")).toContain("Org A");
      expect(result.results.join(" ")).not.toContain("Org B");
      expect(await prisma.usageEvent.count({ where: { conversationId, type: "TOOL_CALL" } })).toBe(1);
    });

    it("refuses to search before a session has actually started, or after it ended", async () => {
      const seed = await seedAgent("a");
      const { conversationId } = await prepareTest(seed);

      const beforeStart = await searchKnowledgeForConversation({
        conversationId,
        query: "hours",
        embeddingProvider: fakeEmbeddingProvider,
      });
      expect(beforeStart).toEqual({ error: "This conversation is not active." });

      await issueVoiceToken({ conversationId, provider: fakeVoiceProvider() });
      await endVoiceSession({ conversationId });
      const afterEnd = await searchKnowledgeForConversation({
        conversationId,
        query: "hours",
        embeddingProvider: fakeEmbeddingProvider,
      });
      expect(afterEnd).toEqual({ error: "This conversation is not active." });
    });
  });

  describe("recordLead", () => {
    async function startedSession(seed: Awaited<ReturnType<typeof seedAgent>>) {
      const { conversationId } = await prepareTest(seed);
      await issueVoiceToken({ conversationId, provider: fakeVoiceProvider() });
      return conversationId;
    }

    it("refuses a lead for a conversation that never started a session", async () => {
      const seed = await seedAgent("a", { leadCapture: true });
      const { conversationId } = await prepareTest(seed);

      const result = await recordLead({ conversationId, phone: "+233200000000" });

      expect(result).toEqual({ ok: false, error: "Conversation not found." });
      expect(await prisma.lead.count()).toBe(0);
    });

    it("refuses leads when lead capture is disabled on the version that ran", async () => {
      const seed = await seedAgent("a", { leadCapture: false });
      const conversationId = await startedSession(seed);

      const result = await recordLead({ conversationId, phone: "+233200000000" });

      expect(result).toEqual({ ok: false, error: "Lead capture is not enabled for this agent." });
      expect(await prisma.lead.count()).toBe(0);
    });

    it("stores the lead under the conversation's own tenant and agent", async () => {
      const seed = await seedAgent("a", { leadCapture: true });
      const conversationId = await startedSession(seed);

      const result = await recordLead({ conversationId, name: "Ama", phone: "+233200000000" });

      expect(result.ok).toBe(true);
      const lead = await prisma.lead.findFirstOrThrow();
      expect(lead).toMatchObject({
        organizationId: seed.organization.id,
        agentId: seed.agent.id,
        conversationId,
        name: "Ama",
        email: null,
      });
    });

    it("caps the number of leads per conversation", async () => {
      const seed = await seedAgent("a", { leadCapture: true });
      const conversationId = await startedSession(seed);

      for (let i = 0; i < 3; i++) {
        expect((await recordLead({ conversationId, name: `Visitor ${i}` })).ok).toBe(true);
      }
      expect((await recordLead({ conversationId, name: "One too many" })).ok).toBe(false);
      expect(await prisma.lead.count()).toBe(3);
    });
  });
});
