/** Shared billing helpers with no server-only imports, so client components can format values too. */

const MINOR_UNITS_PER_MAJOR = 100;
export const MICROS_PER_MAJOR = 1_000_000;

export function formatMoney(minor: number, currency: string): string {
  const major = minor / MINOR_UNITS_PER_MAJOR;
  return `${currency} ${major.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Micro-units (1e-6 of the major unit) — used for provider cost estimates, which are fractions of a pesewa per second. */
export function formatMicros(micros: number, currency: string): string {
  return formatMoney(Math.round(micros / (MICROS_PER_MAJOR / MINOR_UNITS_PER_MAJOR)), currency);
}

/**
 * Parses a user-typed major-unit amount ("299", "299.5", "1,299.00") into minor units.
 * Returns null for anything that isn't a plain non-negative amount with at most 2 decimals.
 */
export function parseMajorToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const minor = Number(whole) * MINOR_UNITS_PER_MAJOR + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajorString(minor: number): string {
  return (minor / MINOR_UNITS_PER_MAJOR).toFixed(2);
}

/** "Starter", or "Pilot (trial)" — without doubling up when the plan is already named as a trial. */
export function planLabel(name: string, isTrial: boolean): string {
  return isTrial && !/trial/i.test(name) ? `${name} (trial)` : name;
}

export function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return `${minutes.toLocaleString("en-GH", { maximumFractionDigits: 1 })} min`;
}

/** Adds calendar months in UTC, clamping to the last day of a shorter month (Jan 31 + 1 → Feb 28/29). */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** Largest whole number of months m with anchor + m months <= date (0 when date is before the anchor). */
export function monthsElapsed(anchor: Date, date: Date): number {
  let months =
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (date.getUTCMonth() - anchor.getUTCMonth());
  months = Math.max(0, months);
  // The estimate can be one too high when date's day-of-month is before the anchor's.
  while (months > 0 && addMonthsUtc(anchor, months) > date) {
    months -= 1;
  }
  return months;
}

/** The monthly billing window, counted from the anchor, that contains date. */
export function billingWindow(anchor: Date, date: Date): { start: Date; end: Date } {
  const index = monthsElapsed(anchor, date);
  return { start: addMonthsUtc(anchor, index), end: addMonthsUtc(anchor, index + 1) };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
