"use client";

import { useEffect, useMemo, useRef } from "react";
import { experimental_useRealtime as useRealtime } from "@ai-sdk/react";
import { gateway } from "@ai-sdk/gateway";
import type { UIMessage } from "ai";

import { Button } from "@/components/ui/button";
import { REALTIME_VOICE_MODEL } from "@/lib/voice";

/** Client-side only — the provider session itself is not server-capped yet (docs/KNOWN_LIMITATIONS.md). */
const MAX_CALL_MS = 15 * 60 * 1000;

export type VoiceSessionConfig = {
  instructions: string;
  voice: string;
  turnDetection: { type: "server-vad" };
};

export type CallEndSummary = { reason: string; usageSeconds: number | null };

type Props = {
  conversationId: string;
  sessionConfig: VoiceSessionConfig;
  stream: MediaStream;
  showTranscript: boolean;
  onEnded: (summary: CallEndSummary) => void;
  onFailed: (message: string) => void;
};

async function runSearchKnowledge(conversationId: string, args: unknown): Promise<unknown> {
  const query =
    typeof args === "object" && args !== null && "query" in args && typeof args.query === "string"
      ? args.query
      : "";
  if (!query) {
    return { error: "No query provided." };
  }
  try {
    const response = await fetch("/api/voice/tools/search-knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, query }),
    });
    return await response.json();
  } catch {
    return { error: "Knowledge search is unavailable right now." };
  }
}

function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

export function ActiveCall({ conversationId, sessionConfig, stream, showTranscript, onEnded, onFailed }: Props) {
  const model = useMemo(() => gateway.experimental_realtime(REALTIME_VOICE_MODEL), []);
  const usageSecondsRef = useRef<number | null>(null);
  const endingRef = useRef(false);
  const wasConnectedRef = useRef(false);

  const { status, messages, isCapturing, isPlaying, connect, close } = useRealtime({
    model,
    api: { token: `/api/voice/sessions/${conversationId}/token` },
    sessionConfig,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName === "search_knowledge") {
        return runSearchKnowledge(conversationId, toolCall.args);
      }
      return { error: `Unknown tool: ${toolCall.toolName}` };
    },
    onEvent: (event) => {
      if (event.type === "session-usage" || event.type === "session-closed") {
        usageSecondsRef.current = event.usage.seconds;
      }
    },
    onError: (error) => {
      if (!endingRef.current) {
        endingRef.current = true;
        onFailed(error.message);
      }
    },
  });

  // Deferred so React Strict Mode's simulated unmount cancels the first attempt before it
  // starts; a second real attempt would hit the token route's single-use guard (409).
  useEffect(() => {
    const timer = setTimeout(() => {
      void connect({ stream, capture: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [connect, stream]);

  useEffect(() => {
    if (status === "connected") {
      wasConnectedRef.current = true;
    }
    if (status === "disconnected" && wasConnectedRef.current && !endingRef.current) {
      endingRef.current = true;
      onEnded({ reason: "remote_disconnected", usageSeconds: usageSecondsRef.current });
    }
  }, [status, onEnded]);

  async function endCall(reason: string) {
    if (endingRef.current) {
      return;
    }
    endingRef.current = true;
    try {
      await close();
    } catch {
      // Final usage is unconfirmed if close fails; the server still records the end.
    }
    onEnded({ reason, usageSeconds: usageSecondsRef.current });
  }

  const endCallRef = useRef(endCall);
  useEffect(() => {
    endCallRef.current = endCall;
  });

  useEffect(() => {
    const timer = setTimeout(() => void endCallRef.current("max_duration"), MAX_CALL_MS);
    return () => clearTimeout(timer);
  }, []);

  const label =
    status === "connecting"
      ? "Connecting…"
      : status === "closing"
        ? "Ending…"
        : isPlaying
          ? "Agent is speaking — you can interrupt"
          : isCapturing
            ? "Listening…"
            : status === "connected"
              ? "Connected"
              : "Starting…";

  const transcript = messages
    .map((message) => ({ id: message.id, role: message.role, text: messageText(message) }))
    .filter((entry) => entry.text.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium text-stone-800">
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              isPlaying ? "bg-amber-500" : status === "connected" ? "bg-emerald-500" : "bg-stone-400"
            }`}
          />
          {label}
        </p>
        <Button type="button" variant="destructive" size="sm" onClick={() => void endCall("user_ended")}>
          End call
        </Button>
      </div>
      {showTranscript ? (
        <ol aria-label="Transcript" className="max-h-64 space-y-2 overflow-y-auto rounded-md bg-stone-50 p-3 text-sm">
          {transcript.length === 0 ? (
            <li className="text-stone-500">The transcript will appear here.</li>
          ) : (
            transcript.map((entry) => (
              <li key={entry.id}>
                <span className="font-medium text-stone-900">{entry.role === "user" ? "You" : "Agent"}: </span>
                <span className="text-stone-700">{entry.text}</span>
              </li>
            ))
          )}
        </ol>
      ) : null}
    </div>
  );
}
