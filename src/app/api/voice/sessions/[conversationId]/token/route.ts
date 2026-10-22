import { NextRequest, NextResponse } from "next/server";

import { issueVoiceToken, VoiceSessionError } from "@/server/voice/session";
import { conversationIdSchema } from "@/lib/validation/voice";

/**
 * Step 2: the URL handed to useRealtime's `api.token`. The hook POSTs its own client-side
 * sessionConfig in the body — deliberately ignored here; nothing from the request body
 * influences what is minted. Returns the shape the AI SDK's RealtimeSetupResponse expects.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;
  const parsedId = conversationIdSchema.safeParse(conversationId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid conversation id." }, { status: 400 });
  }

  try {
    const issued = await issueVoiceToken({ conversationId: parsedId.data });
    return NextResponse.json(issued, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof VoiceSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
