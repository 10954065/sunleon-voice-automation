import "server-only";

import { prisma } from "@/server/db/client";
import type { ConversationChannel, ConversationOutcome, Prisma } from "@/generated/prisma/client";

export const HISTORY_PAGE_SIZE = 25;
const MAX_DETAIL_EVENTS = 200;

export interface ConversationListFilters {
  organizationId: string;
  from: Date;
  to: Date;
  agentId?: string;
  channel?: ConversationChannel;
  outcome?: ConversationOutcome | "IN_PROGRESS";
  cursor?: string;
}

export function conversationWhere(filters: Omit<ConversationListFilters, "cursor">): Prisma.ConversationWhereInput {
  return {
    organizationId: filters.organizationId,
    startedAt: { gte: filters.from, lt: filters.to },
    ...(filters.agentId && { agentId: filters.agentId }),
    ...(filters.channel && { channel: filters.channel }),
    ...(filters.outcome && { outcome: filters.outcome === "IN_PROGRESS" ? null : filters.outcome }),
  };
}

/** Billed seconds per conversation from the usage ledger (one entry per conversation at most). */
async function billedSecondsFor(organizationId: string, conversationIds: string[]): Promise<Map<string, number>> {
  if (conversationIds.length === 0) {
    return new Map();
  }
  const entries = await prisma.usageLedgerEntry.findMany({
    where: { organizationId, metric: "VOICE_SECONDS", conversationId: { in: conversationIds } },
    select: { conversationId: true, quantity: true },
  });
  return new Map(entries.map((entry) => [entry.conversationId as string, entry.quantity]));
}

/**
 * Newest first, keyset-paginated on (startedAt, id). The cursor is only a position: every row still
 * has to match organizationId, so a cursor from another organization can't reveal anything.
 */
export async function listConversations(filters: ConversationListFilters) {
  const rows = await prisma.conversation.findMany({
    where: conversationWhere(filters),
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: HISTORY_PAGE_SIZE + 1,
    ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    include: {
      agent: { select: { name: true } },
      transcript: { select: { id: true } },
      _count: { select: { leads: true } },
    },
  });
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const billed = await billedSecondsFor(
    filters.organizationId,
    page.map((row) => row.id)
  );
  return {
    rows: page.map((row) => ({
      id: row.id,
      agentName: row.agent.name,
      channel: row.channel,
      status: row.status,
      outcome: row.outcome,
      originDomain: row.originDomain,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      connected: Boolean(row.tokenIssuedAt),
      billedSeconds: billed.get(row.id) ?? null,
      leadCount: row._count.leads,
      hasTranscript: Boolean(row.transcript),
    })),
    nextCursor: rows.length > HISTORY_PAGE_SIZE ? page[page.length - 1]?.id ?? null : null,
  };
}

export async function getConversationDetail(organizationId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    include: {
      agent: { select: { id: true, name: true } },
      agentVersion: { select: { versionNumber: true } },
      usageEvents: { orderBy: { createdAt: "asc" }, take: MAX_DETAIL_EVENTS },
      leads: { orderBy: { createdAt: "asc" } },
      transcript: true,
      phoneCall: { include: { phoneNumber: { select: { e164: true } } } },
    },
  });
  if (!conversation) {
    return null;
  }
  const ledgerEntry = await prisma.usageLedgerEntry.findFirst({
    where: { organizationId, conversationId, metric: "VOICE_SECONDS" },
  });
  return { conversation, ledgerEntry };
}
