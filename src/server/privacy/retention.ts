import "server-only";

import { prisma } from "@/server/db/client";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Operational records hold no customer content, but still shouldn't pile up forever. */
export const ERROR_REPORT_RETENTION_DAYS = 90;
export const JOB_RUN_RETENTION_DAYS = 90;

export interface RetentionResult {
  [key: string]: number;
  transcriptsDeleted: number;
  leadsDeleted: number;
  errorReportsDeleted: number;
  jobRunsDeleted: number;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Deletes transcripts (with their summaries) and leads older than each organization's own retention
 * window, and records one audit entry per organization affected. Organizations are grouped by
 * their window so this is a handful of queries, not one per organization. Each group commits on its own,
 * so a failure part-way leaves earlier deletions (and their audit entries) intact.
 */
export async function applyRetention(now: Date = new Date()): Promise<RetentionResult> {
  let transcriptsDeleted = 0;
  const transcriptWindows = await prisma.organization.findMany({
    distinct: ["transcriptRetentionDays"],
    select: { transcriptRetentionDays: true },
  });
  for (const { transcriptRetentionDays: days } of transcriptWindows) {
    const where = { organization: { transcriptRetentionDays: days }, createdAt: { lt: daysBefore(now, days) } };
    transcriptsDeleted += await prisma.$transaction(async (tx) => {
      const perOrganization = await tx.conversationTranscript.groupBy({ by: ["organizationId"], where, _count: true });
      if (perOrganization.length === 0) {
        return 0;
      }
      const deleted = await tx.conversationTranscript.deleteMany({ where });
      await tx.auditLog.createMany({
        data: perOrganization.map((row) => ({
          organizationId: row.organizationId,
          action: "retention.transcripts_deleted",
          metadata: { count: row._count, retentionDays: days },
        })),
      });
      return deleted.count;
    });
  }

  let leadsDeleted = 0;
  const leadWindows = await prisma.organization.findMany({
    distinct: ["leadRetentionDays"],
    select: { leadRetentionDays: true },
  });
  for (const { leadRetentionDays: days } of leadWindows) {
    const where = { organization: { leadRetentionDays: days }, createdAt: { lt: daysBefore(now, days) } };
    leadsDeleted += await prisma.$transaction(async (tx) => {
      const perOrganization = await tx.lead.groupBy({ by: ["organizationId"], where, _count: true });
      if (perOrganization.length === 0) {
        return 0;
      }
      const deleted = await tx.lead.deleteMany({ where });
      await tx.auditLog.createMany({
        data: perOrganization.map((row) => ({
          organizationId: row.organizationId,
          action: "retention.leads_deleted",
          metadata: { count: row._count, retentionDays: days },
        })),
      });
      return deleted.count;
    });
  }

  const [errorReports, jobRuns] = await Promise.all([
    prisma.errorReport.deleteMany({ where: { lastSeenAt: { lt: daysBefore(now, ERROR_REPORT_RETENTION_DAYS) } } }),
    prisma.jobRun.deleteMany({ where: { startedAt: { lt: daysBefore(now, JOB_RUN_RETENTION_DAYS) } } }),
  ]);

  return {
    transcriptsDeleted,
    leadsDeleted,
    errorReportsDeleted: errorReports.count,
    jobRunsDeleted: jobRuns.count,
  };
}
