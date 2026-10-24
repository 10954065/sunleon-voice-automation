import "server-only";

import { REALTIME_VOICE_MODEL } from "@/lib/voice";
import { CARRIER_PROVIDER_ID, REALTIME_SIP_MODEL, SIP_VOICE_PROVIDER_ID } from "@/server/telephony/config";
import { VOICE_PROVIDER_ID } from "./usage";
import type { UsageMetric } from "@/generated/prisma/client";

export interface CostRateKey {
  metric: UsageMetric;
  provider: string;
  model: string;
  label: string;
}

/**
 * Every usage stream with its own provider cost. Each ledger row snapshots the matching rate when it
 * is recorded; a stream with no rate is reported as unpriced, never guessed.
 */
export const COST_RATE_KEYS = {
  "browser-voice": {
    metric: "VOICE_SECONDS",
    provider: VOICE_PROVIDER_ID,
    model: REALTIME_VOICE_MODEL,
    label: "Website and dashboard voice (AI Gateway)",
  },
  "phone-ai": {
    metric: "VOICE_SECONDS",
    provider: SIP_VOICE_PROVIDER_ID,
    model: REALTIME_SIP_MODEL,
    label: "Phone calls — AI (OpenAI Realtime SIP)",
  },
  "carrier-inbound": {
    metric: "TELEPHONY_SECONDS",
    provider: CARRIER_PROVIDER_ID,
    model: "pstn-inbound",
    label: "Phone calls — Twilio inbound minutes",
  },
  "carrier-outbound": {
    metric: "TELEPHONY_SECONDS",
    provider: CARRIER_PROVIDER_ID,
    model: "pstn-outbound",
    label: "Phone calls — Twilio outbound minutes",
  },
} as const satisfies Record<string, CostRateKey>;

export type CostRateKeyId = keyof typeof COST_RATE_KEYS;

export function isCostRateKeyId(value: string): value is CostRateKeyId {
  return Object.prototype.hasOwnProperty.call(COST_RATE_KEYS, value);
}
