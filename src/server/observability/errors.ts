import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/server/db/client";
import { Prisma } from "@/generated/prisma/client";

const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 4000;

export type ErrorSource = "render" | "route" | "action" | "proxy" | "job" | "server";

/**
 * Error text can carry whatever the failing code was handling. Redacts the things that must never
 * reach logs or the monitoring table: credentials, connection strings, emails and phone numbers.
 */
export function scrubSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/g, "[redacted-key]")
    // OpenAI keys (sk-…, sk-proj-…), including the masked form OpenAI echoes back in 401 errors.
    .replace(/\bsk-[A-Za-z0-9_*-]{6,}/g, "[redacted-key]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s'"]+/gi, "[redacted-url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
}

/** Groups repeats of the same error: numbers and ids are normalised so they don't split one problem into many. */
export function errorFingerprint(source: ErrorSource, route: string | null, message: string): string {
  const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>").replace(/\d+/g, "<n>");
  return createHash("sha256").update(`${source}\n${route ?? ""}\n${normalized}`).digest("hex");
}

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: scrubSensitiveText(`${error.name}: ${error.message}`).slice(0, MAX_MESSAGE_CHARS),
      stack: error.stack ? scrubSensitiveText(error.stack).slice(0, MAX_STACK_CHARS) : null,
    };
  }
  return { message: scrubSensitiveText(String(error)).slice(0, MAX_MESSAGE_CHARS), stack: null };
}

/**
 * Records a server error: a structured log line (picked up by the host's log drain) plus a grouped
 * ErrorReport row for /admin/monitoring. Never throws — reporting must not turn one failure into two.
 * There is no external error tracker (e.g. Sentry) yet; see docs/KNOWN_LIMITATIONS.md.
 */
export async function reportError(
  error: unknown,
  context: { source: ErrorSource; route?: string | null; digest?: string | null },
  now: Date = new Date()
): Promise<void> {
  try {
    const route = context.route ?? null;
    const digest = context.digest ?? null;
    const { message, stack } = describe(error);
    console.error(JSON.stringify({ level: "error", source: context.source, route, digest, message }));

    const fingerprint = errorFingerprint(context.source, route, message);
    const update = { occurrences: { increment: 1 }, lastSeenAt: now, message, stack, digest };
    try {
      await prisma.errorReport.upsert({
        where: { fingerprint },
        create: { fingerprint, source: context.source, route, message, stack, digest, firstSeenAt: now, lastSeenAt: now },
        update,
      });
    } catch (writeError) {
      // Two reports of a new error raced to create the row; the loser counts itself on the winner's row.
      if (writeError instanceof Prisma.PrismaClientKnownRequestError && writeError.code === "P2002") {
        await prisma.errorReport.update({ where: { fingerprint }, data: update });
        return;
      }
      throw writeError;
    }
  } catch (reportingError) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "error-reporter",
        message: scrubSensitiveText(reportingError instanceof Error ? reportingError.message : String(reportingError)),
      })
    );
  }
}
