import { z } from "zod";

import { toE164 } from "@/lib/phone";

const optionalE164 = (message: string) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((value, ctx) => {
      if (value === "") {
        return null;
      }
      const e164 = toE164(value);
      if (!e164) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return e164;
    });

const requiredE164 = (message: string) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((value, ctx) => {
      const e164 = toE164(value);
      if (!e164) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return e164;
    });

const checkbox = z.preprocess((value) => value === "on" || value === "true", z.boolean());

export const phoneNumberSettingsSchema = z.object({
  agentId: z.string().trim().max(64).transform((value) => (value === "" ? null : value)),
  transferNumber: optionalE164("Enter the transfer number with its country code, e.g. +233 24 123 4567."),
  inboundEnabled: checkbox,
  outboundEnabled: checkbox,
});

export const outboundCallSchema = z
  .object({
    phoneNumberId: z.string().trim().min(1, "Choose the number to call from.").max(64),
    leadId: z.string().trim().max(64).transform((value) => (value === "" ? undefined : value)),
    destination: z.string().trim().max(40),
    requestConfirmed: checkbox,
  })
  .refine((data) => Boolean(data.leadId || data.destination), {
    message: "Choose a lead or enter a phone number.",
  });

export const optOutSchema = z.object({
  phoneNumber: requiredE164("Enter a valid phone number."),
});

export const REMOVE_OPT_OUT_CONFIRMATION = "REMOVE";

/** Twilio phone number SIDs are "PN" followed by 32 hex characters. */
export const registerPhoneNumberSchema = z.object({
  e164: requiredE164("Enter the number in international format, e.g. +233 30 123 4567."),
  providerNumberSid: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .refine((value) => value === null || /^PN[0-9a-f]{32}$/.test(value), "A Twilio number SID looks like PN followed by 32 characters."),
  organizationSlug: z.string().trim().min(1, "Choose an organization.").max(64),
  label: z.string().trim().max(80).transform((value) => (value === "" ? null : value)),
});
