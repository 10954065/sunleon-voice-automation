import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayRealtimeVoiceProvider,
  isRealtimeVoiceConfigured,
  MissingVoiceCredentialsError,
} from "@/server/voice/provider";

const originalKey = process.env.AI_GATEWAY_API_KEY;

describe("GatewayRealtimeVoiceProvider", () => {
  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalKey;
    }
  });

  it("reports voice as unconfigured without AI_GATEWAY_API_KEY", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    expect(isRealtimeVoiceConfigured()).toBe(false);
  });

  it("refuses to mint a token without credentials instead of faking one", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    await expect(new GatewayRealtimeVoiceProvider().mintToken()).rejects.toBeInstanceOf(MissingVoiceCredentialsError);
  });

  it("reports voice as configured once the key is present", () => {
    process.env.AI_GATEWAY_API_KEY = "placeholder-not-a-real-key";
    expect(isRealtimeVoiceConfigured()).toBe(true);
  });
});
