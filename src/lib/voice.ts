/** Shared between server (src/server/voice/*) and client components — no server-only import here. */
export const REALTIME_VOICE_MODEL = "openai/gpt-realtime-2";

/** Longest single session. The reservation (and so the widget's cutoff) is never above this. */
export const MAX_SESSION_SECONDS = 15 * 60;
/** Below this much remaining allowance a new session isn't worth starting. */
export const MIN_SESSION_SECONDS = 30;

/**
 * OpenAI's documented built-in realtime voices (developers.openai.com, realtime API reference,
 * checked 2026-10-19). Not yet confirmed end-to-end through the AI Gateway without credentials,
 * and none has been evaluated for Ghanaian English — see docs/KNOWN_LIMITATIONS.md.
 */
export const VOICE_CATALOG = [
  { id: "marin", label: "Marin", recommended: true },
  { id: "cedar", label: "Cedar", recommended: true },
  { id: "alloy", label: "Alloy", recommended: false },
  { id: "ash", label: "Ash", recommended: false },
  { id: "ballad", label: "Ballad", recommended: false },
  { id: "coral", label: "Coral", recommended: false },
  { id: "echo", label: "Echo", recommended: false },
  { id: "sage", label: "Sage", recommended: false },
  { id: "shimmer", label: "Shimmer", recommended: false },
  { id: "verse", label: "Verse", recommended: false },
] as const;

export const VOICE_IDS = VOICE_CATALOG.map((voice) => voice.id) as [string, ...string[]];
