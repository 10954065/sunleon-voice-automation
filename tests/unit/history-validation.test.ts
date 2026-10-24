import { describe, expect, it } from "vitest";

import {
  analyticsFiltersSchema,
  auditFiltersSchema,
  conversationFiltersSchema,
  firstValues,
  leadFiltersSchema,
  rangeForDays,
} from "@/lib/validation/history";
import { dataSettingsSchema, eraseContactSchema } from "@/lib/validation/privacy";
import { prepareEmbedSessionSchema, transcriptSchema } from "@/lib/validation/voice";

describe("URL filters", () => {
  it("ignores invalid values instead of failing the page", () => {
    expect(
      conversationFiltersSchema.parse({ days: "13", agent: "'; DROP TABLE", channel: "FAX", outcome: "WON", cursor: "../x" })
    ).toEqual({ days: 30, agent: undefined, channel: undefined, outcome: undefined, cursor: undefined });
  });

  it("accepts the supported values", () => {
    expect(conversationFiltersSchema.parse({ days: "7", agent: "cm1abc", channel: "EMBED", outcome: "IN_PROGRESS" })).toMatchObject({
      days: 7,
      agent: "cm1abc",
      channel: "EMBED",
      outcome: "IN_PROGRESS",
    });
    expect(leadFiltersSchema.parse({ status: "CONTACTED" })).toMatchObject({ status: "CONTACTED" });
    expect(analyticsFiltersSchema.parse({})).toMatchObject({ days: 30 });
    expect(auditFiltersSchema.parse({ action: "privacy." })).toMatchObject({ action: "privacy." });
    expect(auditFiltersSchema.parse({ action: "Privacy%" })).toMatchObject({ action: undefined });
  });

  it("keeps the first value of repeated params", () => {
    expect(firstValues({ a: ["1", "2"], b: "x", c: undefined })).toEqual({ a: "1", b: "x", c: undefined });
  });

  it("builds an inclusive range of whole UTC days ending now", () => {
    const now = new Date("2026-10-23T15:45:00.000Z");
    expect(rangeForDays(7, now)).toEqual({ from: new Date("2026-10-17T00:00:00.000Z"), to: now });
    expect(rangeForDays(1, now).from).toEqual(new Date("2026-10-23T00:00:00.000Z"));
  });
});

describe("privacy forms", () => {
  it("parses the data settings form", () => {
    expect(dataSettingsSchema.parse({ storeTranscripts: "on", transcriptRetentionDays: "14", leadRetentionDays: "90" })).toEqual({
      storeTranscripts: true,
      transcriptRetentionDays: 14,
      leadRetentionDays: 90,
    });
    expect(dataSettingsSchema.parse({ storeTranscripts: null, transcriptRetentionDays: "1", leadRetentionDays: "1095" })).toMatchObject({
      storeTranscripts: false,
    });
  });

  it("enforces the retention ranges", () => {
    expect(dataSettingsSchema.safeParse({ transcriptRetentionDays: "0", leadRetentionDays: "90" }).success).toBe(false);
    expect(dataSettingsSchema.safeParse({ transcriptRetentionDays: "30", leadRetentionDays: "29" }).success).toBe(false);
    expect(dataSettingsSchema.safeParse({ transcriptRetentionDays: "2.5", leadRetentionDays: "90" }).success).toBe(false);
  });

  it("needs an email or a phone number to erase", () => {
    expect(eraseContactSchema.safeParse({ email: "", phone: "" }).success).toBe(false);
    expect(eraseContactSchema.safeParse({ email: "not-an-email", phone: "" }).success).toBe(false);
    expect(eraseContactSchema.safeParse({ email: "", phone: "0241234567" }).success).toBe(true);
  });
});

describe("voice payloads", () => {
  it("defaults transcript consent to false", () => {
    expect(prepareEmbedSessionSchema.parse({ ticket: "a".repeat(20) }).transcriptConsent).toBe(false);
    expect(prepareEmbedSessionSchema.parse({ ticket: "a".repeat(20), transcriptConsent: true }).transcriptConsent).toBe(true);
  });

  it("rejects transcripts with unknown roles or oversized entries", () => {
    expect(transcriptSchema.safeParse([{ role: "system", text: "x" }]).success).toBe(false);
    expect(transcriptSchema.safeParse([{ role: "user", text: "x".repeat(2001) }]).success).toBe(false);
    expect(transcriptSchema.safeParse([{ role: "assistant", text: "Hello" }]).success).toBe(true);
  });
});
