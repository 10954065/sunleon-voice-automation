import { NextRequest, NextResponse } from "next/server";

import { endVoiceSession } from "@/server/voice/session";
import { storeTranscript } from "@/server/conversations/transcripts";
import { conversationIdSchema, endSessionSchema, transcriptSchema } from "@/lib/validation/voice";

/** Room for the largest transcript the widget sends (see MAX_TRANSCRIPT_BYTES) plus the end report. */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Called by the widget (test or embed) when the visitor ends the call, or via
 * navigator.sendBeacon best-effort cleanup on page unload. Idempotent and
 * intentionally permissive about auth — ending a session early is not a security-sensitive
 * action, and endVoiceSession is a no-op for an unknown or already-ended conversation id.
 * A transcript, when included, is stored only if the visitor consented when the call started
 * (storeTranscript re-checks everything server-side and is write-once).
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

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }
  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const parsed = endSessionSchema.safeParse(body ?? {});
  const details = parsed.success ? parsed.data : {};

  await endVoiceSession({
    conversationId: parsedConversationId.data,
    reason: details.reason,
    clientReportedSeconds: details.clientReportedSeconds,
  });

  const transcript =
    body && typeof body === "object" && "transcript" in body ? transcriptSchema.safeParse(body.transcript) : null;
  const transcriptResult = transcript?.success
    ? await storeTranscript({ conversationId: parsedConversationId.data, entries: transcript.data })
    : null;
  return NextResponse.json({ ok: true, ...(transcriptResult && { transcript: transcriptResult }) });
}
