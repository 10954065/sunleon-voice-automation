import { NextRequest, NextResponse } from "next/server";

import { prepareEmbedVoiceSession, VoiceSessionError } from "@/server/voice/session";
import { MissingVoiceCredentialsError } from "@/server/voice/provider";
import { prepareEmbedSessionSchema } from "@/lib/validation/voice";
import { clientIpFrom, isRateLimited } from "@/server/voice/rateLimit";

const MAX_EMBED_SESSIONS_PER_AGENT_PER_MINUTE = 30;

/**
 * Step 1 of a public widget call. Unauthenticated by design: the signed embed ticket
 * (issued by the widget page after its Referer matched the allowlist) is the authorization.
 * Provider configuration details are never revealed to the public caller.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;

  // Tokens are single-use per conversation, so capping session preparation also caps provider
  // token mints. The per-agent ceiling holds even if the IP header is spoofed or tickets replayed.
  const clientIp = clientIpFrom(request.headers);
  if (
    isRateLimited(`embed-session:${clientIp}:${agentId}`) ||
    isRateLimited(`embed-session-agent:${agentId}`, MAX_EMBED_SESSIONS_PER_AGENT_PER_MINUTE)
  ) {
    return NextResponse.json({ error: "Too many requests. Please try again shortly." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = prepareEmbedSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const prepared = await prepareEmbedVoiceSession({
      agentId,
      ticket: parsed.data.ticket,
      transcriptConsent: parsed.data.transcriptConsent,
    });
    return NextResponse.json(prepared);
  } catch (error) {
    if (error instanceof VoiceSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof MissingVoiceCredentialsError) {
      return NextResponse.json(
        { error: "Voice is temporarily unavailable. Please try again later." },
        { status: 503 }
      );
    }
    throw error;
  }
}
