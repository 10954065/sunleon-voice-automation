import { after, NextRequest, NextResponse } from "next/server";

import { getRealtimeSipConfig } from "@/server/telephony/config";
import { handleRealtimeIncoming } from "@/server/telephony/lifecycle";
import { InvalidRealtimeWebhookError, parseRealtimeWebhook } from "@/server/telephony/realtimeSip";
import { runSidebandForCall } from "@/server/telephony/sideband";

/**
 * The call's tool connection runs in after() inside this invocation, so this is the longest any
 * phone session can last (see MAX_PHONE_SESSION_SECONDS). Must be a literal for Next.js.
 */
export const maxDuration = 300;

const MAX_BODY_BYTES = 256 * 1024;

/**
 * OpenAI's project webhook. The Standard Webhooks signature over the raw body is the authentication
 * (verified by the official SDK before anything is read). Only realtime.call.incoming is acted on;
 * any other signed event is acknowledged so OpenAI stops redelivering it.
 */
export async function POST(request: NextRequest) {
  if (!getRealtimeSipConfig()) {
    return NextResponse.json({ error: "Phone AI is not configured." }, { status: 503 });
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  let call;
  try {
    call = await parseRealtimeWebhook(raw, request.headers);
  } catch (error) {
    if (error instanceof InvalidRealtimeWebhookError) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
    }
    throw error;
  }
  if (!call) {
    return NextResponse.json({ result: "ignored" });
  }

  const result = await handleRealtimeIncoming(call);
  if (result.status === "accepted") {
    after(() =>
      runSidebandForCall({
        conversationId: result.conversationId,
        callId: result.callId,
        maxSeconds: result.reservedSeconds,
      })
    );
  }
  return NextResponse.json({ result: result.status }, { headers: { "Cache-Control": "no-store" } });
}
