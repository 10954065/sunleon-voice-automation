"use server";

import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { summarizeConversation, type SummaryResult } from "@/server/conversations/summaries";
import { reportError } from "@/server/observability/errors";
import { isRateLimited } from "@/server/voice/rateLimit";
import { conversationIdSchema } from "@/lib/validation/voice";

/** Each summary is a paid model call; this caps one organization's spend per minute. */
const MAX_SUMMARIES_PER_ORG_PER_MINUTE = 10;

/** Runs on request rather than after every call, so model cost is only spent on conversations someone reads. */
export async function generateConversationSummary(
  organizationSlug: string,
  conversationId: string
): Promise<SummaryResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["AGENT_MANAGER"]);

  const id = conversationIdSchema.safeParse(conversationId);
  if (!id.success) {
    return { ok: false, error: "Invalid conversation." };
  }
  if (isRateLimited(`summary:${context.organization.id}`, MAX_SUMMARIES_PER_ORG_PER_MINUTE)) {
    return { ok: false, error: "Too many summaries requested. Try again in a minute." };
  }

  try {
    return await summarizeConversation({ organizationId: context.organization.id, conversationId: id.data });
  } catch (error) {
    await reportError(error, { source: "action", route: "generateConversationSummary" });
    return { ok: false, error: "The summary couldn't be generated. Try again later." };
  }
}
