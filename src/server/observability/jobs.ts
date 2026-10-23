import "server-only";

import { prisma } from "@/server/db/client";
import { reportError, scrubSensitiveText } from "./errors";
import type { Prisma } from "@/generated/prisma/client";

export type JobOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/**
 * Runs a scheduled job and records the run (JobRun) so /admin/monitoring shows when each job last
 * succeeded. A failure is reported and returned rather than thrown, so the cron route can answer 500
 * with a safe message.
 */
export async function runJob<T extends Prisma.InputJsonObject>(
  job: string,
  work: () => Promise<T>,
  clock: () => Date = () => new Date()
): Promise<JobOutcome<T>> {
  const startedAt = clock();
  try {
    const result = await work();
    await prisma.jobRun.create({
      data: { job, status: "SUCCEEDED", startedAt, finishedAt: clock(), details: result },
    });
    return { ok: true, result };
  } catch (error) {
    const message = scrubSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
    await reportError(error, { source: "job", route: job });
    await prisma.jobRun
      .create({ data: { job, status: "FAILED", startedAt, finishedAt: clock(), error: message } })
      .catch((recordError: unknown) => reportError(recordError, { source: "job", route: `${job}:record` }));
    return { ok: false, error: message };
  }
}
