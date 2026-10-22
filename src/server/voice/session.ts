import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/server/db/client";
import {
  getRealtimeVoiceProvider,
  isRealtimeVoiceConfigured,
  MissingVoiceCredentialsError,
  type RealtimeVoiceProvider,
} from "./provider";
import { buildSessionInstructions } from "./instructions";
import { getKnowledgeSummary } from "./knowledgeContext";
import { isEmbedHostAllowed } from "./domains";
import { verifyEmbedTicket } from "./embedTicket";
import { SEARCH_KNOWLEDGE_TOOL } from "./tools";
import {
  getEmbeddingProvider,
  MissingEmbeddingCredentialsError,
  type EmbeddingProvider,
} from "@/server/knowledge/embeddings";
import { retrieveRelevantChunks } from "@/server/knowledge/retrieval";
import type { Experimental_RealtimeToolDefinition as RealtimeToolDefinition } from "ai";
import type { AgentVersion, ConversationChannel } from "@/generated/prisma/client";

const TOKEN_REQUEST_WINDOW_MS = 2 * 60 * 1000;
const MAX_LEADS_PER_CONVERSATION = 3;
const MAX_DASHBOARD_ERROR_CHARS = 300;

export class VoiceSessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface VoiceSessionConfig {
  instructions: string;
  voice: string;
  turnDetection: { type: "server-vad" };
}

export interface PreparedVoiceSession {
  conversationId: string;
  sessionConfig: VoiceSessionConfig;
}

export interface IssuedVoiceToken {
  token: string;
  url: string;
  expiresAt?: number;
  tools: RealtimeToolDefinition[];
}

async function createConversation(params: {
  organizationId: string;
  organizationName: string;
  agentId: string;
  agentVersion: AgentVersion;
  channel: ConversationChannel;
  originDomain: string | null;
}): Promise<PreparedVoiceSession> {
  if (!isRealtimeVoiceConfigured()) {
    throw new MissingVoiceCredentialsError();
  }

  const knowledgeSummary = await getKnowledgeSummary({
    organizationId: params.organizationId,
    agentId: params.agentId,
  });

  const sessionConfig: VoiceSessionConfig = {
    instructions: buildSessionInstructions({
      organizationName: params.organizationName,
      persona: params.agentVersion.persona,
      tone: params.agentVersion.tone,
      greeting: params.agentVersion.greeting,
      instructions: params.agentVersion.instructions,
      languages: params.agentVersion.languages,
      knowledgeSummary,
    }),
    voice: params.agentVersion.voice,
    turnDetection: { type: "server-vad" },
  };

  // Server-generated (not cuid) because the id doubles as the session's bearer reference
  // for the tool and lead routes — it must be unguessable.
  const conversation = await prisma.conversation.create({
    data: {
      id: randomUUID(),
      organizationId: params.organizationId,
      agentId: params.agentId,
      agentVersionId: params.agentVersion.id,
      channel: params.channel,
      originDomain: params.originDomain,
    },
  });

  return { conversationId: conversation.id, sessionConfig };
}

/** Authenticated path: tests the agent's latest version (draft or published) before publishing. */
export async function prepareTestVoiceSession(params: {
  organizationId: string;
  organizationName: string;
  agentId: string;
}): Promise<PreparedVoiceSession> {
  const agent = await prisma.agent.findFirst({
    where: { id: params.agentId, organizationId: params.organizationId, archivedAt: null },
  });
  if (!agent) {
    throw new VoiceSessionError("Agent not found in this organization.", 404);
  }

  const version = await prisma.agentVersion.findFirst({
    where: { agentId: agent.id },
    orderBy: { versionNumber: "desc" },
  });
  if (!version) {
    throw new VoiceSessionError("This agent has no configuration to test yet.", 400);
  }

  return createConversation({
    organizationId: params.organizationId,
    organizationName: params.organizationName,
    agentId: agent.id,
    agentVersion: version,
    channel: "TEST",
    originDomain: null,
  });
}

/**
 * Public path for the embedded widget. organizationId is never a parameter — it is derived
 * from the agent row. The signed ticket proves the widget page was loaded inside an allowed
 * site; the allowlist is re-checked here in case it changed after the ticket was issued.
 */
export async function prepareEmbedVoiceSession(params: {
  agentId: string;
  ticket: string;
}): Promise<PreparedVoiceSession> {
  const verified = verifyEmbedTicket(params.ticket, params.agentId);
  if (!verified) {
    throw new VoiceSessionError("This widget is not authorized to start a session here.", 403);
  }

  const agent = await prisma.agent.findFirst({
    where: { id: params.agentId, archivedAt: null },
    include: { organization: true, publishedVersion: true },
  });
  if (!agent || !agent.publishedVersion) {
    throw new VoiceSessionError("This agent is not available.", 404);
  }

  if (!isEmbedHostAllowed(verified.host, agent.allowedEmbedDomains)) {
    throw new VoiceSessionError("This widget is not authorized to start a session here.", 403);
  }

  return createConversation({
    organizationId: agent.organizationId,
    organizationName: agent.organization.name,
    agentId: agent.id,
    agentVersion: agent.publishedVersion,
    channel: "EMBED",
    originDomain: verified.host,
  });
}

/**
 * Called by the realtime hook's own token fetch. The atomic updateMany makes issuance
 * single-use per conversation and only within a short window after it was prepared, so a
 * leaked conversationId can't be replayed to mint more provider sessions.
 */
export async function issueVoiceToken(params: {
  conversationId: string;
  provider?: RealtimeVoiceProvider;
  now?: Date;
}): Promise<IssuedVoiceToken> {
  const now = params.now ?? new Date();
  const claimed = await prisma.conversation.updateMany({
    where: {
      id: params.conversationId,
      status: "ACTIVE",
      tokenIssuedAt: null,
      startedAt: { gte: new Date(now.getTime() - TOKEN_REQUEST_WINDOW_MS) },
    },
    data: { tokenIssuedAt: now },
  });
  if (claimed.count !== 1) {
    throw new VoiceSessionError("This voice session has expired or was already started.", 409);
  }

  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
  });

  try {
    const minted = await (params.provider ?? getRealtimeVoiceProvider()).mintToken();
    await prisma.usageEvent.create({
      data: {
        organizationId: conversation.organizationId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        type: "SESSION_STARTED",
        metadata: { channel: conversation.channel, originDomain: conversation.originDomain },
      },
    });
    return {
      token: minted.token,
      url: minted.url,
      ...(minted.expiresAt != null && { expiresAt: minted.expiresAt }),
      tools: [SEARCH_KNOWLEDGE_TOOL],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error minting voice token.";
    await prisma.$transaction([
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "FAILED", endedAt: now, closeReason: "token_mint_failed", errorMessage: message },
      }),
      prisma.usageEvent.create({
        data: {
          organizationId: conversation.organizationId,
          agentId: conversation.agentId,
          conversationId: conversation.id,
          type: "ERROR",
          metadata: { stage: "token_mint", message },
        },
      }),
    ]);
    const publicMessage =
      conversation.channel === "TEST"
        ? message.slice(0, MAX_DASHBOARD_ERROR_CHARS)
        : "Voice is temporarily unavailable. Please try again later.";
    throw new VoiceSessionError(publicMessage, error instanceof MissingVoiceCredentialsError ? 503 : 502);
  }
}

/**
 * Idempotent: unknown or already-ended conversations are a no-op. clientReportedSeconds is
 * stored but labelled as client-reported — it is not trustworthy enough for billing, which
 * Phase 4 must reconcile against the provider's own usage data.
 */
export async function endVoiceSession(params: {
  conversationId: string;
  reason?: string;
  clientReportedSeconds?: number;
  now?: Date;
}): Promise<void> {
  const conversation = await prisma.conversation.findUnique({ where: { id: params.conversationId } });
  if (!conversation || conversation.status !== "ACTIVE") {
    return;
  }

  const now = params.now ?? new Date();
  const reason = params.reason ?? "client_closed";
  const serverDurationSeconds = conversation.tokenIssuedAt
    ? Math.max(0, Math.round((now.getTime() - conversation.tokenIssuedAt.getTime()) / 1000))
    : 0;

  await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "COMPLETED", endedAt: now, closeReason: reason },
    }),
    prisma.usageEvent.create({
      data: {
        organizationId: conversation.organizationId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        type: "SESSION_ENDED",
        metadata: {
          reason,
          serverDurationSeconds,
          ...(params.clientReportedSeconds != null && {
            clientReportedSeconds: params.clientReportedSeconds,
          }),
        },
      },
    }),
  ]);
}

/**
 * Executes the search_knowledge realtime tool. Tenant scope comes only from the
 * conversation row (looked up by its unguessable id), never from request fields, so a
 * tampered client can only search the agent its own session was issued for.
 */
export async function searchKnowledgeForConversation(params: {
  conversationId: string;
  query: string;
  embeddingProvider?: EmbeddingProvider;
}): Promise<{ results: string[] } | { error: string }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, status: "ACTIVE", tokenIssuedAt: { not: null } },
  });
  if (!conversation) {
    return { error: "This conversation is not active." };
  }

  try {
    const provider = params.embeddingProvider ?? getEmbeddingProvider();
    const [queryEmbedding] = await provider.embedMany([params.query]);
    const chunks = await retrieveRelevantChunks({
      organizationId: conversation.organizationId,
      agentId: conversation.agentId,
      queryEmbedding,
      limit: 5,
    });

    await prisma.usageEvent.create({
      data: {
        organizationId: conversation.organizationId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        type: "TOOL_CALL",
        metadata: { tool: "search_knowledge", resultCount: chunks.length },
      },
    });

    return { results: chunks.map((chunk) => chunk.content) };
  } catch (error) {
    if (error instanceof MissingEmbeddingCredentialsError) {
      return { error: "Knowledge search is not configured yet." };
    }
    return { error: "Knowledge search failed." };
  }
}

/**
 * Tenant scope from the conversation row. Requires a session that actually started (token
 * issued), so preparing a conversation alone can't be used to inject leads, and lead capture
 * must be enabled on the version that ran.
 */
export async function recordLead(params: {
  conversationId: string;
  name?: string;
  phone?: string;
  email?: string;
  note?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: params.conversationId, tokenIssuedAt: { not: null } },
    include: { agentVersion: true, _count: { select: { leads: true } } },
  });
  if (!conversation) {
    return { ok: false, error: "Conversation not found." };
  }
  if (!conversation.agentVersion.leadCaptureEnabled) {
    return { ok: false, error: "Lead capture is not enabled for this agent." };
  }
  if (conversation._count.leads >= MAX_LEADS_PER_CONVERSATION) {
    return { ok: false, error: "Contact details were already submitted for this conversation." };
  }

  await prisma.$transaction([
    prisma.lead.create({
      data: {
        organizationId: conversation.organizationId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        name: params.name || null,
        phone: params.phone || null,
        email: params.email || null,
        note: params.note || null,
      },
    }),
    prisma.usageEvent.create({
      data: {
        organizationId: conversation.organizationId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        type: "TOOL_CALL",
        metadata: { tool: "capture_lead" },
      },
    }),
  ]);

  return { ok: true };
}
