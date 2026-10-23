import "server-only";

import { prisma } from "@/server/db/client";
import { normalizeTranscript, type TranscriptEntry } from "@/lib/transcript";
import { transcriptSchema } from "@/lib/validation/voice";
import { Prisma } from "@/generated/prisma/client";

/** A transcript must arrive with or shortly after the end report; a leaked id can't be used to write one later. */
export const TRANSCRIPT_SUBMIT_WINDOW_MS = 10 * 60 * 1000;

export type StoreTranscriptResult = "stored" | "not_permitted" | "too_late" | "empty" | "already_stored";

/**
 * Stores the caller's browser's transcript for a conversation. Accepted only when the visitor
 * consented at the start (Conversation.transcriptConsent), the business still stores transcripts,
 * the session really connected, and it is live or ended within the submit window. Write-once.
 */
export async function storeTranscript(params: {
  conversationId: string;
  entries: ReadonlyArray<{ role: string; text: string }>;
  now?: Date;
}): Promise<StoreTranscriptResult> {
  const now = params.now ?? new Date();
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: { organization: { select: { storeTranscripts: true } } },
  });
  if (
    !conversation ||
    !conversation.transcriptConsent ||
    !conversation.tokenIssuedAt ||
    !conversation.organization.storeTranscripts ||
    conversation.status === "FAILED"
  ) {
    return "not_permitted";
  }
  if (
    conversation.status === "COMPLETED" &&
    (!conversation.endedAt || now.getTime() - conversation.endedAt.getTime() > TRANSCRIPT_SUBMIT_WINDOW_MS)
  ) {
    return "too_late";
  }

  const entries = normalizeTranscript(params.entries);
  if (entries.length === 0) {
    return "empty";
  }

  try {
    await prisma.conversationTranscript.create({
      data: {
        conversationId: conversation.id,
        organizationId: conversation.organizationId,
        entries,
        entryCount: entries.length,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "already_stored";
    }
    throw error;
  }
  return "stored";
}

/** Reads stored entries defensively: anything malformed renders as an empty transcript rather than throwing. */
export function readTranscriptEntries(value: unknown): TranscriptEntry[] {
  const parsed = transcriptSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** The date a stored transcript will be deleted under the organization's current retention setting. */
export function transcriptExpiresAt(createdAt: Date, retentionDays: number): Date {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}
