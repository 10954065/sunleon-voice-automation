import "server-only";

import { prisma } from "@/server/db/client";
import { resolveEntitlements, type Entitlements } from "./entitlements";

const REPORT_ORGANIZATION_LIMIT = 100;
/** 1 minor unit (pesewa) = 0.01 GHS = 10,000 micro-GHS. */
const MICROS_PER_MINOR = 10_000;

export interface OrganizationCostRow {
  organizationId: string;
  name: string;
  slug: string;
  entitlements: Entitlements;
  usedSeconds: number;
  unpricedSeconds: number;
  estimatedCostMicros: number;
  revenueMinor: number;
  /** Revenue minus estimated provider cost, in micro-units. Null when some usage has no cost rate. */
  marginMicros: number | null;
}

/**
 * Per-organization cost report for the current billing period of each organization. Revenue is
 * successful payments received during that period; cost is the sum of the per-session estimate
 * snapshots. Both are estimates — reconciling against provider invoices is a manual step.
 */
export async function getCostReport(now: Date = new Date()): Promise<OrganizationCostRow[]> {
  const organizations = await prisma.organization.findMany({
    orderBy: { createdAt: "desc" },
    take: REPORT_ORGANIZATION_LIMIT,
    select: { id: true, name: true, slug: true },
  });

  return Promise.all(
    organizations.map(async (organization) => {
      const entitlements = await resolveEntitlements(prisma, organization.id, now);
      if (!entitlements.periodStart || !entitlements.periodEnd) {
        return emptyRow(organization, entitlements);
      }
      const range = { gte: entitlements.periodStart, lt: entitlements.periodEnd };
      const [usage, unpriced, revenue] = await Promise.all([
        prisma.usageLedgerEntry.aggregate({
          where: { organizationId: organization.id, occurredAt: range },
          _sum: { quantity: true, estimatedCostMicros: true },
        }),
        prisma.usageLedgerEntry.aggregate({
          where: { organizationId: organization.id, occurredAt: range, estimatedCostMicros: null },
          _sum: { quantity: true },
        }),
        prisma.billingTransaction.aggregate({
          where: { organizationId: organization.id, status: "SUCCESS", paidAt: range },
          _sum: { amountMinor: true },
        }),
      ]);
      const estimatedCostMicros = usage._sum.estimatedCostMicros ?? 0;
      const unpricedSeconds = unpriced._sum.quantity ?? 0;
      const revenueMinor = revenue._sum.amountMinor ?? 0;
      return {
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        entitlements,
        usedSeconds: usage._sum.quantity ?? 0,
        unpricedSeconds,
        estimatedCostMicros,
        revenueMinor,
        marginMicros: unpricedSeconds > 0 ? null : revenueMinor * MICROS_PER_MINOR - estimatedCostMicros,
      };
    })
  );
}

function emptyRow(organization: { id: string; name: string; slug: string }, entitlements: Entitlements): OrganizationCostRow {
  return {
    organizationId: organization.id,
    name: organization.name,
    slug: organization.slug,
    entitlements,
    usedSeconds: 0,
    unpricedSeconds: 0,
    estimatedCostMicros: 0,
    revenueMinor: 0,
    marginMicros: 0,
  };
}
