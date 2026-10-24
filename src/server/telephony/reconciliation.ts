import "server-only";

import { prisma } from "@/server/db/client";
import { recordCarrierUsage } from "@/server/billing/usage";
import { CARRIER_PROVIDER_ID, SIP_VOICE_PROVIDER_ID } from "./config";
import { isTerminalStatus } from "./lifecycle";
import { getTelephonyCarrier, type TelephonyCarrier } from "./twilio";

/** Calls younger than this are left for their own callbacks to finish. */
const SETTLE_DELAY_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 200;
const MAX_REPORTED_MISMATCHES = 20;

export type CarrierMismatch = {
  conversationId: string;
  organizationId: string;
  callbackSeconds: number;
  carrierSeconds: number;
};

/** A type alias (not an interface) so it is a valid JSON object for the JobRun record. */
export type TelephonyReconciliationResult = {
  checked: number;
  reconciled: number;
  /** Carrier usage recorded here because the completed callback never arrived. */
  recoveredCarrierUsage: number;
  stillInProgress: number;
  fetchFailures: number;
  mismatches: CarrierMismatch[];
};

/**
 * Daily: for each finished call not yet reconciled, fetches Twilio's own record (duration, price),
 * stores it, fills in carrier usage that a lost callback never recorded, and reports any call where
 * the callback's duration and Twilio's record disagree. Idempotent: reconciled calls are skipped and
 * carrier usage is keyed per conversation.
 */
export async function reconcileTelephonyCalls(
  params: { now?: Date; carrier?: TelephonyCarrier; limit?: number } = {}
): Promise<TelephonyReconciliationResult> {
  const now = params.now ?? new Date();
  const carrier = params.carrier ?? getTelephonyCarrier();
  const calls = await prisma.phoneCall.findMany({
    where: {
      reconciledAt: null,
      providerCallSid: { not: null },
      createdAt: { lt: new Date(now.getTime() - SETTLE_DELAY_MS), gte: new Date(now.getTime() - LOOKBACK_MS) },
    },
    include: { conversation: { select: { agentId: true } } },
    orderBy: { createdAt: "asc" },
    take: params.limit ?? DEFAULT_BATCH,
  });

  const result: TelephonyReconciliationResult = {
    checked: calls.length,
    reconciled: 0,
    recoveredCarrierUsage: 0,
    stillInProgress: 0,
    fetchFailures: 0,
    mismatches: [],
  };

  for (const call of calls) {
    let record;
    try {
      record = await carrier.fetchCall(call.providerCallSid as string);
    } catch {
      result.fetchFailures += 1;
      continue;
    }
    if (!isTerminalStatus(record.status)) {
      result.stillInProgress += 1;
      continue;
    }

    const carrierSeconds = record.durationSeconds ?? 0;
    if (call.carrierSeconds != null && call.carrierSeconds !== carrierSeconds && result.mismatches.length < MAX_REPORTED_MISMATCHES) {
      result.mismatches.push({
        conversationId: call.conversationId,
        organizationId: call.organizationId,
        callbackSeconds: call.carrierSeconds,
        carrierSeconds,
      });
    }
    await prisma.phoneCall.update({
      where: { id: call.id },
      data: {
        carrierSeconds: call.carrierSeconds ?? carrierSeconds,
        carrierPriceMicros: record.priceMicros,
        carrierPriceUnit: record.priceUnit,
        reconciledAt: now,
        ...(!isTerminalStatus(call.providerStatus) && { providerStatus: record.status, endedAt: call.endedAt ?? now }),
      },
    });
    if (carrierSeconds > 0) {
      const recorded = await recordCarrierUsage(prisma, {
        organizationId: call.organizationId,
        agentId: call.conversation.agentId,
        conversationId: call.conversationId,
        seconds: carrierSeconds,
        occurredAt: call.createdAt,
        provider: CARRIER_PROVIDER_ID,
        model: `pstn-${call.direction.toLowerCase()}`,
        source: "provider_reconciliation",
      });
      if (recorded) {
        result.recoveredCarrierUsage += 1;
      }
    }
    result.reconciled += 1;
  }
  return result;
}

export interface TelephonyReportRow {
  organizationId: string;
  name: string;
  slug: string;
  calls: number;
  unreconciled: number;
  /** AI seconds charged to the organization's allowance for phone calls. */
  aiBilledSeconds: number;
  /** Twilio's measurement of the AI legs (DialCallDuration). */
  aiLegSeconds: number;
  /** Carrier seconds in the usage ledger. */
  carrierLedgerSeconds: number;
  /** Carrier seconds on the call records (callback or Twilio's API). */
  carrierSeconds: number;
  carrierPriceMicros: number;
}

/** Per-organization comparison of what we billed against what the providers measured. */
export async function getTelephonyReconciliationReport(since: Date): Promise<TelephonyReportRow[]> {
  const [calls, unreconciled, ledger] = await Promise.all([
    prisma.phoneCall.groupBy({
      by: ["organizationId"],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { aiLegSeconds: true, carrierSeconds: true, carrierPriceMicros: true },
    }),
    prisma.phoneCall.groupBy({
      by: ["organizationId"],
      where: { createdAt: { gte: since }, reconciledAt: null, providerCallSid: { not: null } },
      _count: true,
    }),
    prisma.usageLedgerEntry.groupBy({
      by: ["organizationId", "metric"],
      where: { occurredAt: { gte: since }, provider: { in: [SIP_VOICE_PROVIDER_ID, CARRIER_PROVIDER_ID] } },
      _sum: { quantity: true },
    }),
  ]);
  const organizations = await prisma.organization.findMany({
    where: { id: { in: calls.map((row) => row.organizationId) } },
    select: { id: true, name: true, slug: true },
  });
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  const unreconciledById = new Map(unreconciled.map((row) => [row.organizationId, row._count]));
  const ledgerSum = (organizationId: string, metric: "VOICE_SECONDS" | "TELEPHONY_SECONDS") =>
    ledger.find((row) => row.organizationId === organizationId && row.metric === metric)?._sum.quantity ?? 0;

  return calls
    .map((row) => ({
      organizationId: row.organizationId,
      name: byId.get(row.organizationId)?.name ?? "Unknown",
      slug: byId.get(row.organizationId)?.slug ?? "",
      calls: row._count,
      unreconciled: unreconciledById.get(row.organizationId) ?? 0,
      aiBilledSeconds: ledgerSum(row.organizationId, "VOICE_SECONDS"),
      aiLegSeconds: row._sum.aiLegSeconds ?? 0,
      carrierLedgerSeconds: ledgerSum(row.organizationId, "TELEPHONY_SECONDS"),
      carrierSeconds: row._sum.carrierSeconds ?? 0,
      carrierPriceMicros: row._sum.carrierPriceMicros ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}
