import "server-only";

import { prisma } from "@/server/db/client";
import { isPaymentConfigured } from "@/server/billing/paystack";
import { MAX_SESSION_SECONDS } from "@/lib/voice";
import { STALE_GRACE_SECONDS } from "@/server/billing/usage";

export const ADMIN_ORG_PAGE_SIZE = 50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Jobs scheduled in vercel.json; monitoring flags any that hasn't succeeded within this window. */
export const SCHEDULED_JOBS = ["sweep-sessions", "retention"] as const;
export const JOB_STALE_AFTER_MS = 26 * HOUR_MS;

/**
 * Cross-tenant organization list for platform admins: counts and plan state only. Transcripts and
 * leads (customers' visitors' data) are deliberately not exposed in the platform console.
 */
export async function listOrganizationsForAdmin(params: { cursor?: string; now?: Date }) {
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const rows = await prisma.organization.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_ORG_PAGE_SIZE + 1,
    ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
    include: {
      subscription: { include: { plan: { select: { name: true } } } },
      _count: { select: { memberships: true, agents: { where: { archivedAt: null } } } },
    },
  });
  const page = rows.slice(0, ADMIN_ORG_PAGE_SIZE);
  const ids = page.map((org) => org.id);
  const [conversations, usage] = await Promise.all([
    prisma.conversation.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: ids }, startedAt: { gte: since } },
      _count: true,
    }),
    prisma.usageLedgerEntry.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: ids }, metric: "VOICE_SECONDS", occurredAt: { gte: since } },
      _sum: { quantity: true },
    }),
  ]);
  const conversationCounts = new Map(conversations.map((row) => [row.organizationId, row._count]));
  const usageSeconds = new Map(usage.map((row) => [row.organizationId, row._sum.quantity ?? 0]));

  return {
    rows: page.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt,
      members: org._count.memberships,
      agents: org._count.agents,
      plan: org.subscription
        ? { name: org.subscription.plan.name, status: org.subscription.status, paidThroughAt: org.subscription.paidThroughAt }
        : null,
      conversations30d: conversationCounts.get(org.id) ?? 0,
      voiceSeconds30d: usageSeconds.get(org.id) ?? 0,
      storesTranscripts: org.storeTranscripts,
    })),
    nextCursor: rows.length > ADMIN_ORG_PAGE_SIZE ? page[page.length - 1]?.id ?? null : null,
  };
}

async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Everything /admin/monitoring shows, from recorded rows and configuration presence (never secret values). */
export async function getMonitoringSnapshot(now: Date = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  // Older than any session can legitimately live (reservation cap + grace + token window).
  const stuckBefore = new Date(now.getTime() - (MAX_SESSION_SECONDS + STALE_GRACE_SECONDS) * 1000 - 2 * 60 * 1000);

  const [
    database,
    errorReports,
    errors24h,
    jobRuns,
    stuckSessions,
    failedConversations24h,
    recentFailures,
    errorEvents24h,
    failedKnowledgeSources,
    webhookGroups,
    problemTransactions,
  ] = await Promise.all([
    databaseReachable(),
    prisma.errorReport.findMany({ orderBy: { lastSeenAt: "desc" }, take: 50 }),
    prisma.errorReport.count({ where: { lastSeenAt: { gte: dayAgo } } }),
    Promise.all(
      SCHEDULED_JOBS.map(async (job) => ({
        job,
        lastRun: await prisma.jobRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" } }),
        lastSuccess: await prisma.jobRun.findFirst({ where: { job, status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
      }))
    ),
    prisma.conversation.count({ where: { status: "ACTIVE", startedAt: { lt: stuckBefore } } }),
    prisma.conversation.count({ where: { status: "FAILED", endedAt: { gte: dayAgo } } }),
    prisma.conversation.findMany({
      where: { status: "FAILED" },
      orderBy: { endedAt: "desc" },
      take: 10,
      select: { id: true, endedAt: true, closeReason: true, errorMessage: true, channel: true, organization: { select: { name: true } } },
    }),
    prisma.usageEvent.count({ where: { type: "ERROR", createdAt: { gte: dayAgo } } }),
    prisma.knowledgeSource.count({ where: { status: "FAILED" } }),
    prisma.paymentWebhookEvent.groupBy({ by: ["status"], where: { receivedAt: { gte: weekAgo } }, _count: true }),
    prisma.billingTransaction.count({ where: { status: { in: ["FAILED", "REJECTED"] }, createdAt: { gte: weekAgo } } }),
  ]);

  return {
    checkedAt: now,
    database,
    configuration: {
      aiGateway: Boolean(process.env.AI_GATEWAY_API_KEY),
      paystack: isPaymentConfigured(),
      cronSecret: Boolean(process.env.CRON_SECRET?.trim()),
    },
    errorReports,
    errors24h,
    jobs: jobRuns.map((entry) => ({
      ...entry,
      stale: !entry.lastSuccess || now.getTime() - entry.lastSuccess.startedAt.getTime() > JOB_STALE_AFTER_MS,
    })),
    stuckSessions,
    failedConversations24h,
    recentFailures,
    errorEvents24h,
    failedKnowledgeSources,
    webhooks7d: {
      processed: webhookGroups.find((group) => group.status === "PROCESSED")?._count ?? 0,
      ignored: webhookGroups.find((group) => group.status === "IGNORED")?._count ?? 0,
    },
    problemTransactions7d: problemTransactions,
  };
}
