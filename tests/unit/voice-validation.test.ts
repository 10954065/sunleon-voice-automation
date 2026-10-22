import { describe, expect, it } from "vitest";

import {
  captureLeadSchema,
  conversationIdSchema,
  embedDomainsSchema,
  endSessionSchema,
  prepareEmbedSessionSchema,
} from "@/lib/validation/voice";
import { updateAgentDraftSchema } from "@/lib/validation/agent";
import { VOICE_CATALOG, VOICE_IDS } from "@/lib/voice";

const conversationId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("voice validation", () => {
  it("only accepts UUID conversation ids", () => {
    expect(conversationIdSchema.safeParse(conversationId).success).toBe(true);
    expect(conversationIdSchema.safeParse("clx123notauuid").success).toBe(false);
    expect(conversationIdSchema.safeParse("' OR 1=1 --").success).toBe(false);
  });

  it("requires at least one way to contact a lead", () => {
    expect(captureLeadSchema.safeParse({ conversationId, note: "call me" }).success).toBe(false);
    expect(captureLeadSchema.safeParse({ conversationId, phone: "+233 20 000 0000" }).success).toBe(true);
  });

  it("rejects an invalid lead email", () => {
    expect(captureLeadSchema.safeParse({ conversationId, email: "not-an-email" }).success).toBe(false);
  });

  it("accepts bare hostnames only for embed domains", () => {
    expect(embedDomainsSchema.safeParse(["example.com.gh", "www.example.com"]).success).toBe(true);
    expect(embedDomainsSchema.safeParse(["https://example.com"]).success).toBe(false);
    expect(embedDomainsSchema.safeParse(["example.com/path"]).success).toBe(false);
    expect(embedDomainsSchema.safeParse(["*.example.com"]).success).toBe(false);
  });

  it("normalizes embed domains to lowercase", () => {
    const parsed = embedDomainsSchema.parse(["Example.COM"]);
    expect(parsed).toEqual(["example.com"]);
  });

  it("caps the number of embed domains", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `site${i}.com`);
    expect(embedDomainsSchema.safeParse(tooMany).success).toBe(false);
  });

  it("bounds client-reported session seconds", () => {
    expect(endSessionSchema.safeParse({ clientReportedSeconds: 120 }).success).toBe(true);
    expect(endSessionSchema.safeParse({ clientReportedSeconds: -1 }).success).toBe(false);
    expect(endSessionSchema.safeParse({ clientReportedSeconds: 1.5 }).success).toBe(false);
  });

  it("requires an embed ticket to prepare a public session", () => {
    expect(prepareEmbedSessionSchema.safeParse({}).success).toBe(false);
    expect(prepareEmbedSessionSchema.safeParse({ ticket: "abcdefghij.klmnop" }).success).toBe(true);
  });
});

describe("voice catalog", () => {
  it("only lets a draft select a voice from the catalog", () => {
    const valid = {
      instructions: "Answer questions about our shop.",
      languages: ["en"],
      leadCaptureEnabled: false,
    };
    expect(updateAgentDraftSchema.safeParse({ ...valid, voice: "marin" }).success).toBe(true);
    expect(updateAgentDraftSchema.safeParse({ ...valid, voice: "made-up-voice" }).success).toBe(false);
    expect(updateAgentDraftSchema.safeParse(valid).success).toBe(true);
  });

  it("exposes the same ids as the catalog and marks recommended voices", () => {
    expect(VOICE_IDS).toEqual(VOICE_CATALOG.map((voice) => voice.id));
    expect(VOICE_CATALOG.filter((voice) => voice.recommended).map((voice) => voice.id)).toEqual(["marin", "cedar"]);
  });
});
