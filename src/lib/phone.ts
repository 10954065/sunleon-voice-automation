/** Shared between server and client components — no server-only import here. */

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
export const GHANA_CALLING_CODE = "233";

/**
 * Normalises what people type into E.164. Ghana national numbers ("024 123 4567") and numbers
 * without the plus ("233241234567", "00233…") are accepted; anything else must already be E.164.
 * Returns null when the input can't be a phone number.
 */
export function toE164(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, "");
  if (compact === "") {
    return null;
  }
  let candidate: string;
  if (compact.startsWith("+")) {
    candidate = compact;
  } else if (compact.startsWith("00")) {
    candidate = `+${compact.slice(2)}`;
  } else if (/^0\d{9}$/.test(compact)) {
    candidate = `+${GHANA_CALLING_CODE}${compact.slice(1)}`;
  } else if (compact.startsWith(GHANA_CALLING_CODE) && compact.length === 12) {
    candidate = `+${compact}`;
  } else {
    return null;
  }
  return E164_PATTERN.test(candidate) ? candidate : null;
}

/** "+233241234567" → "+233 ••• ••• 567". Enough to recognise a number without exposing it. */
export function maskPhoneNumber(e164: string | null | undefined): string {
  if (!e164) {
    return "Unknown";
  }
  const lastDigits = e164.slice(-3);
  const code = e164.startsWith(`+${GHANA_CALLING_CODE}`) ? `+${GHANA_CALLING_CODE}` : e164.slice(0, 2);
  return `${code} ••• ••• ${lastDigits}`;
}
