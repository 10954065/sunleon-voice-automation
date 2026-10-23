import "server-only";

import { prisma } from "@/server/db/client";
import { Prisma, type ConversationChannel, type ConversationOutcome } from "@/generated/prisma/client";

export interface AnalyticsFilters {
  organizationId: string;
  /** Inclusive start and exclusive end, on conversation start time (UTC). */
  from: Date;
  to: Date;
  channel?: ConversationChannel;
  agentId?: string;
}

export interface AnalyticsRow {
  sessions: number;
  connected: number;
  voiceSeconds: number;
  leadConversations: number;
}

export interface AnalyticsReport {
  totals: AnalyticsRow & {
    inProgress: number;
    /** Billed seconds per connected session, rounded; null when nothing connected. */
    averageConnectedSeconds: number | null;
    /** Share of connected sessions that captured a lead (0-1); null when nothing connected. */
    leadRate: number | null;
  };
  outcomes: Array<{ outcome: ConversationOutcome | "IN_PROGRESS"; count: number }>;
  channels: Record<ConversationChannel, number>;
  /** One row per UTC day in the range, zero-filled so charts show quiet days. */
  daily: Array<AnalyticsRow & { day: string }>;
  agents: Array<AnalyticsRow & { agentId: string; name: string }>;
}

type RawRow = { key: string | Date; sessions: number; connected: number; voiceSeconds: number; leadConversations: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function whereClause(filters: AnalyticsFilters): Prisma.Sql {
  const conditions = [
    Prisma.sql`c."organizationId" = ${filters.organizationId}`,
    Prisma.sql`c."startedAt" >= ${filters.from}`,
    Prisma.sql`c."startedAt" < ${filters.to}`,
  ];
  if (filters.channel) {
    conditions.push(Prisma.sql`c."channel" = ${filters.channel}::"ConversationChannel"`);
  }
  if (filters.agentId) {
    conditions.push(Prisma.sql`c."agentId" = ${filters.agentId}`);
  }
  return Prisma.join(conditions, " AND ");
}

/**
 * Every figure comes from recorded rows: Conversation (sessions, connection, outcome) joined to its
 * usage-ledger entry (billed seconds, at most one per conversation by its idempotency key). Nothing
 * is sampled or estimated. Leads are counted as conversations whose outcome is LEAD_CAPTURED, so the
 * figure survives lead retention and erasure.
 */
async function aggregate(filters: AnalyticsFilters, groupBy: "day" | "agent"): Promise<RawRow[]> {
  const key = groupBy === "day" ? Prisma.sql`date_trunc('day', c."startedAt")` : Prisma.sql`c."agentId"`;
  return prisma.$queryRaw<RawRow[]>`
    SELECT ${key} AS "key",
      count(*)::int AS "sessions",
      count(c."tokenIssuedAt")::int AS "connected",
      coalesce(sum(u."quantity"), 0)::int AS "voiceSeconds",
      count(*) FILTER (WHERE c."outcome" = 'LEAD_CAPTURED')::int AS "leadConversations"
    FROM "Conversation" c
    LEFT JOIN "UsageLedgerEntry" u ON u."conversationId" = c."id" AND u."metric" = 'VOICE_SECONDS'
    WHERE ${whereClause(filters)}
    GROUP BY 1
    ORDER BY 1`;
}

function dayKey(value: string | Date): string {
  return (value instanceof Date ? value : new Date(`${value}Z`)).toISOString().slice(0, 10);
}

function zeroFilledDays(from: Date, to: Date, rows: RawRow[]): AnalyticsReport["daily"] {
  const byDay = new Map(rows.map((row) => [dayKey(row.key), row]));
  const days: AnalyticsReport["daily"] = [];
  const first = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let time = first; time < to.getTime(); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const row = byDay.get(day);
    days.push({
      day,
      sessions: row?.sessions ?? 0,
      connected: row?.connected ?? 0,
      voiceSeconds: row?.voiceSeconds ?? 0,
      leadConversations: row?.leadConversations ?? 0,
    });
  }
  return days;
}

export async function getAnalyticsReport(filters: AnalyticsFilters): Promise<AnalyticsReport> {
  const conversationWhere: Prisma.ConversationWhereInput = {
    organizationId: filters.organizationId,
    startedAt: { gte: filters.from, lt: filters.to },
    ...(filters.channel && { channel: filters.channel }),
    ...(filters.agentId && { agentId: filters.agentId }),
  };

  const [dailyRows, agentRows, outcomeGroups, channelGroups] = await Promise.all([
    aggregate(filters, "day"),
    aggregate(filters, "agent"),
    prisma.conversation.groupBy({ by: ["outcome"], where: conversationWhere, _count: true }),
    prisma.conversation.groupBy({ by: ["channel"], where: conversationWhere, _count: true }),
  ]);

  const agentNames = new Map(
    (
      await prisma.agent.findMany({
        where: { organizationId: filters.organizationId, id: { in: agentRows.map((row) => String(row.key)) } },
        select: { id: true, name: true },
      })
    ).map((agent) => [agent.id, agent.name])
  );

  const totals = dailyRows.reduce<AnalyticsRow>(
    (sum, row) => ({
      sessions: sum.sessions + row.sessions,
      connected: sum.connected + row.connected,
      voiceSeconds: sum.voiceSeconds + row.voiceSeconds,
      leadConversations: sum.leadConversations + row.leadConversations,
    }),
    { sessions: 0, connected: 0, voiceSeconds: 0, leadConversations: 0 }
  );
  const inProgress = outcomeGroups.find((group) => group.outcome === null)?._count ?? 0;

  return {
    totals: {
      ...totals,
      inProgress,
      averageConnectedSeconds: totals.connected > 0 ? Math.round(totals.voiceSeconds / totals.connected) : null,
      leadRate: totals.connected > 0 ? totals.leadConversations / totals.connected : null,
    },
    outcomes: outcomeGroups
      .map((group) => ({ outcome: group.outcome ?? ("IN_PROGRESS" as const), count: group._count }))
      .sort((a, b) => b.count - a.count),
    channels: {
      TEST: channelGroups.find((group) => group.channel === "TEST")?._count ?? 0,
      EMBED: channelGroups.find((group) => group.channel === "EMBED")?._count ?? 0,
    },
    daily: zeroFilledDays(filters.from, filters.to, dailyRows),
    agents: agentRows
      .map((row) => ({
        agentId: String(row.key),
        name: agentNames.get(String(row.key)) ?? "Deleted agent",
        sessions: row.sessions,
        connected: row.connected,
        voiceSeconds: row.voiceSeconds,
        leadConversations: row.leadConversations,
      }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}
