import "server-only";

import { prisma } from "@/server/db/client";
import { isLiveConversation, settleConversation, UNSTARTED_SESSION_TTL_MS } from "./usage";
import type { Conversation, Prisma } from "@/generated/prisma/client";

const DEFAULT_SWEEP_LIMIT = 500;

/**
 * Closes one abandoned conversation. A session that never got a token cost nothing; one that
 * did is charged its full reservation, because the server can't see how long the provider
 * session really ran when the browser never reported its end. That's a conservative estimate,
 * bounded by the reservation (never more than MAX_SESSION_SECONDS).
 */
async function closeAbandoned(tx: Prisma.TransactionClient, conversation: Conversation, now: Date): Promise<boolean> {
  return settleConversation(tx, {
    conversation,
    reason: conversation.tokenIssuedAt ? "abandoned" : "not_started",
    chargedSeconds: conversation.reservedSeconds,
    source: "sweeper_reservation",
    now,
  });
}

/** Used inside the quota reservation transaction, which already holds the organization's lock. */
export async function sweepOrganization(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date
): Promise<number> {
  const active = await tx.conversation.findMany({ where: { organizationId, status: "ACTIVE" } });
  let closed = 0;
  for (const conversation of active) {
    if (!isLiveConversation(conversation, now) && (await closeAbandoned(tx, conversation, now))) {
      closed += 1;
    }
  }
  return closed;
}

/** Platform-wide backstop, run by the cron route. Each conversation settles in its own transaction. */
export async function sweepStaleSessions(params: { now?: Date; limit?: number } = {}): Promise<{ closed: number }> {
  const now = params.now ?? new Date();
  // Anything stale is at least this old, so the query stays cheap; liveness is checked per row.
  const candidates = await prisma.conversation.findMany({
    where: { status: "ACTIVE", startedAt: { lt: new Date(now.getTime() - UNSTARTED_SESSION_TTL_MS) } },
    orderBy: { startedAt: "asc" },
    take: params.limit ?? DEFAULT_SWEEP_LIMIT,
  });

  let closed = 0;
  for (const conversation of candidates) {
    if (isLiveConversation(conversation, now)) {
      continue;
    }
    if (await prisma.$transaction((tx) => closeAbandoned(tx, conversation, now))) {
      closed += 1;
    }
  }
  return { closed };
}
