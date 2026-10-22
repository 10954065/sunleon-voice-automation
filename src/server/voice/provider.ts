import "server-only";

import type { Experimental_RealtimeFactoryGetTokenResult as RealtimeTokenResult } from "ai";
import { REALTIME_VOICE_MODEL } from "@/lib/voice";

export { REALTIME_VOICE_MODEL };

const TOKEN_TTL_SECONDS = 60;

export class MissingVoiceCredentialsError extends Error {
  constructor() {
    super(
      "Voice is not configured: AI_GATEWAY_API_KEY is not set, so no real-time provider " +
        "token can be minted. See docs/PROVIDER_INTEGRATIONS.md."
    );
  }
}

export function isRealtimeVoiceConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}

export interface RealtimeVoiceProvider {
  mintToken(): Promise<RealtimeTokenResult>;
}

/**
 * Mints a single-use, short-lived Gateway client secret so the browser never holds
 * AI_GATEWAY_API_KEY. The Gateway realtime model ignores any sessionConfig passed at mint
 * time — instructions, voice and tools are applied by the browser's session-update event —
 * so none is passed here. See docs/DECISIONS.md for what that means for instruction privacy.
 */
export class GatewayRealtimeVoiceProvider implements RealtimeVoiceProvider {
  async mintToken(): Promise<RealtimeTokenResult> {
    if (!isRealtimeVoiceConfigured()) {
      throw new MissingVoiceCredentialsError();
    }

    const { gateway } = await import("@ai-sdk/gateway");
    return gateway.experimental_realtime.getToken({
      model: REALTIME_VOICE_MODEL,
      expiresAfterSeconds: TOKEN_TTL_SECONDS,
    });
  }
}

export function getRealtimeVoiceProvider(): RealtimeVoiceProvider {
  return new GatewayRealtimeVoiceProvider();
}
