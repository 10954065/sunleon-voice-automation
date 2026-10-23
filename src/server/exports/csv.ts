import "server-only";

import { prisma } from "@/server/db/client";

/** Bounds one export's size and query cost; the response says when it was cut short. */
export const MAX_EXPORT_ROWS = 10_000;

type Cell = string | number | boolean | Date | null | undefined;

/**
 * One CSV field. Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with
 * an apostrophe, because lead names and notes are typed by website visitors.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 with CRLF line endings and a UTF-8 byte-order mark so Excel reads non-ASCII names correctly. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export interface CsvExport {
  csv: string;
  rowCount: number;
  truncated: boolean;
}

/** Conversation metadata only — never transcript text or visitors' contact details. */
export async function exportConversations(params: { organizationId: string; from: Date; to: Date }): Promise<CsvExport> {
  const rows = await prisma.conversation.findMany({
    where: { organizationId: params.organizationId, startedAt: { gte: params.from, lt: params.to } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: MAX_EXPORT_ROWS + 1,
    include: {
      agent: { select: { name: true } },
      transcript: { select: { id: true } },
      _count: { select: { leads: true } },
    },
  });
  const page = rows.slice(0, MAX_EXPORT_ROWS);
  const ledger = await prisma.usageLedgerEntry.findMany({
    where: {
      organizationId: params.organizationId,
      metric: "VOICE_SECONDS",
      conversationId: { in: page.map((row) => row.id) },
    },
    select: { conversationId: true, quantity: true },
  });
  const billed = new Map(ledger.map((entry) => [entry.conversationId, entry.quantity]));

  const csv = toCsv(
    [
      "conversation_id",
      "started_at_utc",
      "ended_at_utc",
      "agent",
      "channel",
      "website",
      "status",
      "outcome",
      "connected",
      "billed_seconds",
      "leads",
      "transcript_stored",
    ],
    page.map((row) => [
      row.id,
      row.startedAt,
      row.endedAt,
      row.agent.name,
      row.channel,
      row.originDomain,
      row.status,
      row.outcome ?? "IN_PROGRESS",
      Boolean(row.tokenIssuedAt),
      billed.get(row.id) ?? null,
      row._count.leads,
      Boolean(row.transcript),
    ])
  );
  return { csv, rowCount: page.length, truncated: rows.length > MAX_EXPORT_ROWS };
}

/** Visitors' contact details: callers must restrict this to roles allowed to export personal data. */
export async function exportLeads(params: { organizationId: string; from: Date; to: Date }): Promise<CsvExport> {
  const rows = await prisma.lead.findMany({
    where: { organizationId: params.organizationId, createdAt: { gte: params.from, lt: params.to } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_EXPORT_ROWS + 1,
    include: { agent: { select: { name: true } } },
  });
  const page = rows.slice(0, MAX_EXPORT_ROWS);
  const csv = toCsv(
    ["lead_id", "created_at_utc", "agent", "status", "name", "phone", "email", "note", "conversation_id"],
    page.map((lead) => [
      lead.id,
      lead.createdAt,
      lead.agent.name,
      lead.status,
      lead.name,
      lead.phone,
      lead.email,
      lead.note,
      lead.conversationId,
    ])
  );
  return { csv, rowCount: page.length, truncated: rows.length > MAX_EXPORT_ROWS };
}
