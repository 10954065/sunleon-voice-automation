"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FeedbackText, type Feedback } from "@/components/ui/feedback";
import { generateConversationSummary } from "@/server/actions/conversations";
import { deleteConversationTranscript } from "@/server/actions/privacy";

export function GenerateSummaryButton({ orgSlug, conversationId, label }: { orgSlug: string; conversationId: string; label: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function generate() {
    setFeedback(null);
    startTransition(async () => {
      const result = await generateConversationSummary(orgSlug, conversationId);
      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error });
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" variant="outline" onClick={generate} disabled={isPending}>
        {isPending ? "Summarising…" : label}
      </Button>
      <FeedbackText feedback={feedback} />
    </div>
  );
}

export function DeleteTranscriptButton({ orgSlug, conversationId }: { orgSlug: string; conversationId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await deleteConversationTranscript(orgSlug, conversationId);
      setConfirming(false);
      setFeedback(result.ok ? { kind: "success", text: result.message } : { kind: "error", text: result.error });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-red-800">Delete this transcript and its summary permanently?</span>
          <Button type="button" size="sm" variant="destructive" onClick={remove} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
            Keep
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Delete transcript
        </Button>
      )}
      <FeedbackText feedback={feedback} />
    </div>
  );
}
