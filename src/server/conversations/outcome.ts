import type { ConversationOutcome } from "@/generated/prisma/client";

/** A connected session shorter than this is classified SHORT (a hang-up or a misdial). */
export const SHORT_CONVERSATION_SECONDS = 15;

export const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  NOT_CONNECTED: "Not connected",
  FAILED: "Failed",
  ABANDONED: "Ended without a report",
  SHORT: "Short (under 15s)",
  ENGAGED: "Conversation",
  LEAD_CAPTURED: "Lead captured",
};

/**
 * Classifies a finished conversation from recorded facts only — no model guesses. The order is
 * the precedence: a failure or a session that never connected outranks everything, and a
 * captured lead outranks how long the call was. The phase5 migration backfills with the same rules.
 */
export function classifyOutcome(facts: {
  failed: boolean;
  connected: boolean;
  leadCount: number;
  abandoned: boolean;
  chargedSeconds: number;
}): ConversationOutcome {
  if (facts.failed) {
    return "FAILED";
  }
  if (!facts.connected) {
    return "NOT_CONNECTED";
  }
  if (facts.leadCount > 0) {
    return "LEAD_CAPTURED";
  }
  if (facts.abandoned) {
    return "ABANDONED";
  }
  return facts.chargedSeconds < SHORT_CONVERSATION_SECONDS ? "SHORT" : "ENGAGED";
}
