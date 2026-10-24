/** Display helpers shared by the dashboard pages. All times are shown in UTC (Ghana's local time). */

export function formatDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
}

/** 0 → "0s", 75 → "1m 15s", 3700 → "61m 40s". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** How a session reached the agent: "Dashboard test", "Website · example.com" or "Phone". */
export function channelLabel(channel: "TEST" | "EMBED" | "PHONE", originDomain?: string | null): string {
  if (channel === "TEST") {
    return "Dashboard test";
  }
  if (channel === "PHONE") {
    return "Phone";
  }
  return originDomain ? `Website · ${originDomain}` : "Website";
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

/** Builds a query string from the defined values only, for filter and pagination links. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
