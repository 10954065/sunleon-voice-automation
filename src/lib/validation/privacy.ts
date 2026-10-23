import { z } from "zod";

/** Matching CHECK constraints in the phase5 migration. */
export const TRANSCRIPT_RETENTION_RANGE = { min: 1, max: 365 } as const;
export const LEAD_RETENTION_RANGE = { min: 30, max: 1095 } as const;

const checkbox = z.unknown().transform((value) => value === "on" || value === "true");

export const dataSettingsSchema = z.object({
  storeTranscripts: checkbox,
  transcriptRetentionDays: z.coerce
    .number({ error: "Enter a number of days." })
    .int("Enter a whole number of days.")
    .min(TRANSCRIPT_RETENTION_RANGE.min, `Keep transcripts for at least ${TRANSCRIPT_RETENTION_RANGE.min} day.`)
    .max(TRANSCRIPT_RETENTION_RANGE.max, `Transcripts can be kept for at most ${TRANSCRIPT_RETENTION_RANGE.max} days.`),
  leadRetentionDays: z.coerce
    .number({ error: "Enter a number of days." })
    .int("Enter a whole number of days.")
    .min(LEAD_RETENTION_RANGE.min, `Keep leads for at least ${LEAD_RETENTION_RANGE.min} days.`)
    .max(LEAD_RETENTION_RANGE.max, `Leads can be kept for at most ${LEAD_RETENTION_RANGE.max} days.`),
});

export const eraseContactSchema = z
  .object({
    email: z.string().trim().max(200).email("Enter a valid email address.").optional().or(z.literal("")),
    phone: z.string().trim().max(50).optional().or(z.literal("")),
  })
  .refine((data) => Boolean(data.email || data.phone), { message: "Enter an email address or a phone number." });

export const leadStatusSchema = z.enum(["NEW", "CONTACTED", "CLOSED"]);

/** Typed by the owner to confirm deleting every stored transcript. */
export const DELETE_ALL_CONFIRMATION = "DELETE";
