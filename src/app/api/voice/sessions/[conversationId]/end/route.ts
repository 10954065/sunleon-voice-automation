import { NextRequest, NextResponse } from "next/server";

import { endVoiceSession } from "@/server/voice/session";
import { conversationIdSchema, endSessionSchema } from "@/lib/validation/voice";

/**
 * Called by the widget (test or embed) when the visitor ends the call, or via
 * navigator.sendBeacon best-effort cleanup on page unload. Idempotent and
 * intentionally permissive about auth — ending a session early is not a security-sensitive
 * action, and endVoiceSession is a no-op for an unknown or already-ended conversation id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;

  const parsedConversationId = conversationIdSchema.safeParse(conversationId);
  if (!parsedConversationId.success) {
    return NextResponse.json({ error: "Invalid conversation id." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const parsed = endSessionSchema.safeParse(body ?? {});
  const details = parsed.success ? parsed.data : {};

  await endVoiceSession({
    conversationId: parsedConversationId.data,
    reason: details.reason,
    clientReportedSeconds: details.clientReportedSeconds,
  });
  return NextResponse.json({ ok: true });
}
