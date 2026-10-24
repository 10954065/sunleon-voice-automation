import "server-only";

import { prisma } from "@/server/db/client";
import { maskPhoneNumber } from "@/lib/phone";
import { getPublicBaseUrl, getRealtimeSipConfig, getTwilioCredentials } from "./config";

const RECENT_CALL_LIMIT = 25;
const OPT_OUT_LIMIT = 100;
const CALLABLE_LEAD_LIMIT = 50;
const CALLABLE_LEAD_DAYS = 30;

export interface TelephonyReadiness {
  twilio: boolean;
  realtimeSip: boolean;
  publicUrl: boolean;
}

export function getTelephonyReadiness(): TelephonyReadiness {
  return {
    twilio: Boolean(getTwilioCredentials()),
    realtimeSip: Boolean(getRealtimeSipConfig()),
    publicUrl: Boolean(getPublicBaseUrl()),
  };
}

/**
 * Everything the Phone page shows for one organization. Phone numbers of callers and opted-out people
 * are masked here, before they reach the page; leads keep their number because staff call them back.
 */
export async function getPhoneOverview(organizationId: string, now: Date = new Date()) {
  const [numbers, agents, calls, optOuts, leads] = await Promise.all([
    prisma.phoneNumber.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      include: { agent: { select: { id: true, name: true } } },
    }),
    prisma.agent.findMany({
      where: { organizationId, archivedAt: null, publishedVersionId: { not: null } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.phoneCall.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: RECENT_CALL_LIMIT,
      include: { conversation: { select: { outcome: true, status: true } }, phoneNumber: { select: { e164: true } } },
    }),
    prisma.callOptOut.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: OPT_OUT_LIMIT,
    }),
    prisma.lead.findMany({
      where: {
        organizationId,
        phone: { not: null },
        createdAt: { gte: new Date(now.getTime() - CALLABLE_LEAD_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: CALLABLE_LEAD_LIMIT,
      select: { id: true, name: true, phone: true, createdAt: true },
    }),
  ]);

  return {
    readiness: getTelephonyReadiness(),
    numbers,
    agents,
    calls: calls.map((call) => ({
      id: call.id,
      conversationId: call.conversationId,
      direction: call.direction,
      remote: maskPhoneNumber(call.remoteNumber),
      ourNumber: call.phoneNumber?.e164 ?? null,
      providerStatus: call.providerStatus,
      carrierSeconds: call.carrierSeconds,
      aiLegSeconds: call.aiLegSeconds,
      transferStatus: call.transferStatus,
      outcome: call.conversation.outcome,
      createdAt: call.createdAt,
    })),
    optOuts: optOuts.map((entry) => ({
      id: entry.id,
      phone: maskPhoneNumber(entry.phoneNumber),
      source: entry.source,
      createdAt: entry.createdAt,
    })),
    leads,
  };
}
