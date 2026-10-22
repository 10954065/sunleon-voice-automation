"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ActiveCall, type CallEndSummary, type VoiceSessionConfig } from "./active-call";
import { LeadCaptureForm } from "./lead-capture-form";

type Phase =
  | { kind: "consent" }
  | { kind: "starting"; step: "microphone" | "connecting" }
  | { kind: "in-call"; conversationId: string; sessionConfig: VoiceSessionConfig; stream: MediaStream }
  | { kind: "ended"; conversationId: string }
  | { kind: "error"; message: string; conversationId: string | null };

export type VoiceWidgetProps = {
  businessName: string;
  leadCaptureEnabled: boolean;
  /** Step-1 endpoint: the dashboard test route or the public embed route. */
  prepareUrl: string;
  prepareBody?: Record<string, string>;
  /** Shown above the consent notice, e.g. "Testing your current draft". */
  contextNote?: string;
};

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was blocked. Allow microphone access for this page in your browser, then try again.";
    }
    if (error.name === "NotFoundError") {
      return "No microphone was found. Connect a microphone and try again.";
    }
    if (error.name === "NotReadableError") {
      return "Your microphone is in use by another app. Close it and try again.";
    }
  }
  return "Could not access your microphone.";
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

function reportEnd(conversationId: string, body: Record<string, unknown>) {
  void fetch(`/api/voice/sessions/${conversationId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined);
}

export function VoiceWidget({ businessName, leadCaptureEnabled, prepareUrl, prepareBody, contextNote }: VoiceWidgetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "consent" });
  const [showTranscript, setShowTranscript] = useState(true);
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Best-effort: if the visitor closes the tab mid-call, still record the end server-side.
  useEffect(() => {
    function handlePageHide() {
      const current = phaseRef.current;
      if (current.kind === "in-call") {
        const blob = new Blob([JSON.stringify({ reason: "page_closed" })], { type: "application/json" });
        navigator.sendBeacon(`/api/voice/sessions/${current.conversationId}/end`, blob);
      }
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  // Client-side navigation away from the page unmounts the widget without a pagehide event:
  // release the microphone and record the end so the session isn't left ACTIVE.
  useEffect(() => {
    return () => {
      const current = phaseRef.current;
      if (current.kind === "in-call") {
        stopStream(current.stream);
        reportEnd(current.conversationId, { reason: "widget_closed" });
      }
    };
  }, []);

  async function startConversation() {
    setPhase({ kind: "starting", step: "microphone" });

    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase({
        kind: "error",
        message: "This browser can't access a microphone here. Try a current version of Chrome, Edge, Safari or Firefox.",
        conversationId: null,
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      setPhase({ kind: "error", message: microphoneErrorMessage(error), conversationId: null });
      return;
    }

    setPhase({ kind: "starting", step: "connecting" });
    try {
      const response = await fetch(prepareUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepareBody ?? {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.conversationId || !payload?.sessionConfig) {
        stopStream(stream);
        setPhase({
          kind: "error",
          message: payload?.error ?? "The voice agent couldn't start. Please try again.",
          conversationId: null,
        });
        return;
      }
      setPhase({
        kind: "in-call",
        conversationId: payload.conversationId,
        sessionConfig: payload.sessionConfig,
        stream,
      });
    } catch {
      stopStream(stream);
      setPhase({
        kind: "error",
        message: "Couldn't reach the voice service. Check your connection and try again.",
        conversationId: null,
      });
    }
  }

  const handleEnded = useCallback((summary: CallEndSummary) => {
    const current = phaseRef.current;
    if (current.kind !== "in-call") {
      return;
    }
    stopStream(current.stream);
    reportEnd(current.conversationId, {
      reason: summary.reason,
      ...(summary.usageSeconds != null && { clientReportedSeconds: Math.round(summary.usageSeconds) }),
    });
    setPhase({ kind: "ended", conversationId: current.conversationId });
  }, []);

  const handleFailed = useCallback((message: string) => {
    const current = phaseRef.current;
    if (current.kind !== "in-call") {
      return;
    }
    stopStream(current.stream);
    reportEnd(current.conversationId, { reason: "client_error" });
    setPhase({
      kind: "error",
      message: `The call was interrupted: ${message}`,
      conversationId: current.conversationId,
    });
  }, []);

  return (
    <section aria-label={`Voice assistant for ${businessName}`} className="space-y-4">
      {contextNote ? <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{contextNote}</p> : null}

      {phase.kind === "consent" || phase.kind === "starting" ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-700">
            You&apos;re about to talk with an <strong>AI voice assistant</strong> for {businessName}. Your voice is
            streamed to our AI provider to generate spoken replies. This widget does not record or store your audio
            or the transcript; it logs only session timing and any contact details you choose to share.
          </p>
          <Button type="button" onClick={() => void startConversation()} disabled={phase.kind === "starting"}>
            {phase.kind !== "starting"
              ? "Allow microphone and start talking"
              : phase.step === "microphone"
                ? "Waiting for microphone permission…"
                : "Starting…"}
          </Button>
        </div>
      ) : null}

      {phase.kind === "in-call" ? (
        <>
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={showTranscript}
              onChange={(event) => setShowTranscript(event.target.checked)}
            />
            Show transcript
          </label>
          <ActiveCall
            key={phase.conversationId}
            conversationId={phase.conversationId}
            sessionConfig={phase.sessionConfig}
            stream={phase.stream}
            showTranscript={showTranscript}
            onEnded={handleEnded}
            onFailed={handleFailed}
          />
          {leadCaptureEnabled ? (
            <LeadCaptureForm conversationId={phase.conversationId} businessName={businessName} />
          ) : null}
        </>
      ) : null}

      {phase.kind === "ended" ? (
        <div className="space-y-4">
          <p role="status" className="text-sm text-stone-700">
            Conversation ended.
          </p>
          {leadCaptureEnabled ? (
            <LeadCaptureForm conversationId={phase.conversationId} businessName={businessName} />
          ) : null}
          <Button type="button" variant="outline" onClick={() => setPhase({ kind: "consent" })}>
            Start a new conversation
          </Button>
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-red-700">
            {phase.message}
          </p>
          <Button type="button" variant="outline" onClick={() => void startConversation()}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}
