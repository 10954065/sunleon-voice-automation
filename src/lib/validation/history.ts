import { z } from "zod";

/** Search-param filters for the history, leads, analytics and audit pages. Invalid values are ignored, not errors. */
export const RANGE_DAYS = [7, 30, 90, 365] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const idParam = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .optional()
  .catch(undefined);

const rangeParam = z.coerce
  .number()
  .refine((value): value is RangeDays => (RANGE_DAYS as readonly number[]).includes(value))
  .catch(30)
  .default(30);

const channelParam = z.enum(["TEST", "EMBED"]).optional().catch(undefined);

export const conversationFiltersSchema = z.object({
  days: rangeParam,
  agent: idParam,
  channel: channelParam,
  outcome: z
    .enum(["NOT_CONNECTED", "FAILED", "ABANDONED", "SHORT", "ENGAGED", "LEAD_CAPTURED", "IN_PROGRESS"])
    .optional()
    .catch(undefined),
  cursor: idParam,
});

export const leadFiltersSchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "CLOSED"]).optional().catch(undefined),
  agent: idParam,
  cursor: idParam,
});

export const analyticsFiltersSchema = z.object({
  days: rangeParam,
  agent: idParam,
  channel: channelParam,
});

export const auditFiltersSchema = z.object({
  action: z
    .string()
    .trim()
    .regex(/^[a-z_.]{1,60}$/)
    .optional()
    .catch(undefined),
  cursor: idParam,
});

export const exportQuerySchema = z.object({
  days: rangeParam,
});

/** Takes Next.js searchParams (string | string[] | undefined values) and keeps the first value of each. */
export function firstValues(params: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

/** The last `days` UTC days including today: from midnight UTC `days - 1` days ago up to now. */
export function rangeForDays(days: number, now: Date = new Date()): { from: Date; to: Date } {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(todayStart - (days - 1) * DAY_MS), to: now };
}
