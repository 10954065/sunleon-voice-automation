"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FeedbackText, type Feedback } from "@/components/ui/feedback";
import { deleteLead, updateLeadStatus } from "@/server/actions/leads";

const STATUS_LABELS = { NEW: "New", CONTACTED: "Contacted", CLOSED: "Closed" } as const;

export function LeadControls({
  orgSlug,
  leadId,
  status,
  canEditStatus,
  canDelete,
}: {
  orgSlug: string;
  leadId: string;
  status: keyof typeof STATUS_LABELS;
  canEditStatus: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function changeStatus(next: string) {
    setFeedback(null);
    startTransition(async () => {
      const result = await updateLeadStatus(orgSlug, leadId, next);
      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error });
      }
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteLead(orgSlug, leadId);
      setConfirming(false);
      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error });
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {canEditStatus ? (
        <select
          aria-label="Lead status"
          defaultValue={status}
          disabled={isPending}
          onChange={(event) => changeStatus(event.target.value)}
          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900"
        >
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">{STATUS_LABELS[status]}</span>
      )}
      {canDelete ? (
        confirming ? (
          <>
            <Button type="button" size="sm" variant="destructive" onClick={remove} disabled={isPending}>
              {isPending ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={isPending}>
              Keep
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )
      ) : null}
      <FeedbackText feedback={feedback} />
    </div>
  );
}
