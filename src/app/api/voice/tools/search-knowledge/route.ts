import { NextRequest, NextResponse } from "next/server";

import { searchKnowledgeForConversation } from "@/server/voice/session";
import { searchKnowledgeSchema } from "@/lib/validation/voice";
import { isRateLimited } from "@/server/voice/rateLimit";

/**
 * Executed by the widget's onToolCall handler when the realtime model calls
 * search_knowledge mid-conversation. Public, unauthenticated by design — tenant scoping
 * comes entirely from conversationId (see searchKnowledgeForConversation), which is why
 * this route never reads organizationId/agentId from the request body.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = searchKnowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  }

  if (isRateLimited(`search:${parsed.data.conversationId}`, 20)) {
    return NextResponse.json({ error: "Too many knowledge searches. Slow down." }, { status: 429 });
  }

  const result = await searchKnowledgeForConversation(parsed.data);
  return NextResponse.json(result);
}
