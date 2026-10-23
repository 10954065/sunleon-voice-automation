import { z } from "zod";

import { MAX_TRANSCRIPT_ENTRIES, MAX_TRANSCRIPT_ENTRY_CHARS } from "@/lib/transcript";

export const conversationIdSchema = z.string().uuid("Invalid conversation id.");

export const searchKnowledgeSchema = z.object({
  conversationId: conversationIdSchema,
  query: z.string().trim().min(1, "Query is required").max(500),
});

export const captureLeadSchema = z
  .object({
    conversationId: conversationIdSchema,
    name: z.string().trim().max(200).optional().or(z.literal("")),
    phone: z.string().trim().max(50).optional().or(z.literal("")),
    email: z.string().trim().email("Invalid email").max(200).optional().or(z.literal("")),
    note: z.string().trim().max(2000).optional().or(z.literal("")),
  })
  .refine((data) => Boolean(data.name || data.phone || data.email), {
    message: "Provide at least a name, phone, or email.",
  });

export const endSessionSchema = z.object({
  reason: z.string().trim().max(100).optional(),
  clientReportedSeconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
});

/**
 * Sent alongside the end report when the visitor consented to a stored transcript. Parsed apart
 * from endSessionSchema so a malformed transcript never stops the session from being ended.
 * Over-long entries are rejected here rather than silently cut, since the widget trims first.
 */
export const transcriptSchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      text: z.string().max(MAX_TRANSCRIPT_ENTRY_CHARS),
    })
  )
  .max(MAX_TRANSCRIPT_ENTRIES);

/** The visitor's answer to "save a transcript?" — only meaningful when the business stores transcripts. */
const transcriptConsentField = z.boolean().optional().default(false);

export const prepareTestSessionSchema = z.object({
  transcriptConsent: transcriptConsentField,
});

export const prepareEmbedSessionSchema = z.object({
  ticket: z.string().min(10).max(2000),
  transcriptConsent: transcriptConsentField,
});

export const embedDomainsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9.-]+$/, "Enter a bare hostname, e.g. example.com")
  )
  .max(20);
