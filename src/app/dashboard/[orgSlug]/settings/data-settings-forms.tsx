"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FeedbackText, type Feedback } from "@/components/ui/feedback";
import { deleteAllTranscripts, eraseContact, updateDataSettings, type PrivacyActionResult } from "@/server/actions/privacy";
import { DELETE_ALL_CONFIRMATION, LEAD_RETENTION_RANGE, TRANSCRIPT_RETENTION_RANGE } from "@/lib/validation/privacy";

/** Runs a privacy action from a form and shows its result; refreshes the page data on success. */
function useActionForm(action: (formData: FormData) => Promise<PrivacyActionResult>) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setFeedback(null);
    startTransition(async () => {
      const result = await action(formData);
      setFeedback(result.ok ? { kind: "success", text: result.message } : { kind: "error", text: result.error });
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return { feedback, isPending, onSubmit };
}

export function DataSettingsForm({
  orgSlug,
  storeTranscripts,
  transcriptRetentionDays,
  leadRetentionDays,
  canEdit,
}: {
  orgSlug: string;
  storeTranscripts: boolean;
  transcriptRetentionDays: number;
  leadRetentionDays: number;
  canEdit: boolean;
}) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => updateDataSettings(orgSlug, formData));

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <fieldset disabled={!canEdit || isPending} className="space-y-4">
        <label className="flex items-start gap-2 text-sm text-stone-800">
          <input type="checkbox" name="storeTranscripts" defaultChecked={storeTranscripts} className="mt-1" />
          <span>
            Offer visitors a stored transcript. Each visitor decides with a checkbox before the call starts (unticked by
            default); transcripts are only kept for those who tick it.
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="transcriptRetentionDays">Keep transcripts for (days)</Label>
            <Input
              id="transcriptRetentionDays"
              name="transcriptRetentionDays"
              type="number"
              min={TRANSCRIPT_RETENTION_RANGE.min}
              max={TRANSCRIPT_RETENTION_RANGE.max}
              defaultValue={transcriptRetentionDays}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="leadRetentionDays">Keep leads for (days)</Label>
            <Input
              id="leadRetentionDays"
              name="leadRetentionDays"
              type="number"
              min={LEAD_RETENTION_RANGE.min}
              max={LEAD_RETENTION_RANGE.max}
              defaultValue={leadRetentionDays}
              required
            />
          </div>
        </div>
      </fieldset>
      {canEdit ? (
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving…" : "Save data settings"}
        </Button>
      ) : (
        <p className="text-xs text-stone-500">Only the owner can change these settings.</p>
      )}
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function EraseContactForm({ orgSlug }: { orgSlug: string }) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => eraseContact(orgSlug, formData));

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="erase-email">Email</Label>
          <Input id="erase-email" name="email" type="email" autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="erase-phone">Phone</Label>
          <Input id="erase-phone" name="phone" type="tel" autoComplete="off" />
        </div>
      </div>
      <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
        {isPending ? "Erasing…" : "Erase this person's data"}
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function DeleteAllTranscriptsForm({ orgSlug, count }: { orgSlug: string; count: number }) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => deleteAllTranscripts(orgSlug, formData));

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="confirmation">
          Type {DELETE_ALL_CONFIRMATION} to delete all {count} stored transcript{count === 1 ? "" : "s"} and their summaries
        </Label>
        <Input id="confirmation" name="confirmation" autoComplete="off" className="max-w-xs" />
      </div>
      <Button type="submit" size="sm" variant="destructive" disabled={isPending || count === 0}>
        {isPending ? "Deleting…" : "Delete all transcripts"}
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}
