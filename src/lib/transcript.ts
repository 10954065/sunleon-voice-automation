/** Shared by the widget (which sends a transcript when the call ends) and the server (which validates it). */
export const MAX_TRANSCRIPT_ENTRIES = 200;
export const MAX_TRANSCRIPT_ENTRY_CHARS = 2000;
/** sendBeacon payloads are capped at 64 KiB by browsers; leave room for the rest of the end report. */
export const MAX_TRANSCRIPT_BYTES = 56 * 1024;

export type TranscriptRole = "user" | "assistant";
export type TranscriptEntry = { role: TranscriptRole; text: string };

/** Drops empty and unknown-role entries and trims each one to the per-entry limit. */
export function normalizeTranscript(entries: ReadonlyArray<{ role: string; text: string }>): TranscriptEntry[] {
  return entries
    .filter((entry): entry is TranscriptEntry => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({ role: entry.role, text: entry.text.trim().slice(0, MAX_TRANSCRIPT_ENTRY_CHARS) }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, MAX_TRANSCRIPT_ENTRIES);
}

/** Keeps the opening of the conversation that fits within maxBytes of JSON, so a long call still sends something. */
export function fitTranscript(entries: TranscriptEntry[], maxBytes = MAX_TRANSCRIPT_BYTES): TranscriptEntry[] {
  const encoder = new TextEncoder();
  const fitted: TranscriptEntry[] = [];
  let bytes = 2; // the surrounding []
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(entry)).length + 1;
    if (bytes + size > maxBytes) {
      break;
    }
    fitted.push(entry);
    bytes += size;
  }
  return fitted;
}
