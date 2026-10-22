"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelSubscription,
  confirmCheckout,
  startCheckout,
  updateOverageBudget,
} from "@/server/actions/billing";

type Feedback = { kind: "error" | "success"; text: string } | null;

function FeedbackText({ feedback }: { feedback: Feedback }) {
  if (!feedback) {
    return null;
  }
  return (
    <p className={feedback.kind === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}>{feedback.text}</p>
  );
}

export function ChoosePlanButton({ orgSlug, planCode, label }: { orgSlug: string; planCode: string; label: string }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function choose() {
    setFeedback(null);
    startTransition(async () => {
      const result = await startCheckout(orgSlug, planCode);
      if (!result.ok) {
        setFeedback({ kind: "error", text: result.error });
        return;
      }
      if (result.redirectUrl) {
        window.location.assign(result.redirectUrl);
      }
    });
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" onClick={choose} disabled={isPending}>
        {isPending ? "Opening Paystack…" : label}
      </Button>
      <FeedbackText feedback={feedback} />
    </div>
  );
}

/** Runs once when Paystack redirects back with ?reference=, then refreshes the page's data. */
export function ConfirmPayment({ orgSlug, reference }: { orgSlug: string; reference: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>({ kind: "success", text: "Checking your payment with Paystack…" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void confirmCheckout(orgSlug, reference)
      .then((result) => {
        setFeedback(
          result.ok
            ? { kind: "success", text: result.message ?? "Payment checked." }
            : { kind: "error", text: result.error }
        );
        router.refresh();
      })
      .catch(() => setFeedback({ kind: "error", text: "Couldn't check the payment. Refresh the page to try again." }));
  }, [orgSlug, reference, router]);

  return (
    <div className="rounded-md border border-stone-200 bg-white px-4 py-3">
      <FeedbackText feedback={feedback} />
    </div>
  );
}

export function CancelSubscriptionButton({ orgSlug, paidThrough }: { orgSlug: string; paidThrough: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function cancel() {
    setFeedback(null);
    startTransition(async () => {
      const result = await cancelSubscription(orgSlug);
      setConfirming(false);
      setFeedback(result.ok ? { kind: "success", text: result.message ?? "Cancelled." } : { kind: "error", text: result.error });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-800">
            Stop renewing? Your plan stays active until {paidThrough}, then voice sessions stop.
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={cancel} disabled={isPending}>
              {isPending ? "Cancelling…" : "Yes, cancel renewal"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
              Keep subscription
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Cancel subscription
        </Button>
      )}
      <FeedbackText feedback={feedback} />
    </div>
  );
}

export function OverageBudgetForm({
  orgSlug,
  currentBudget,
  currency,
  canEdit,
}: {
  orgSlug: string;
  currentBudget: string;
  currency: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await updateOverageBudget(orgSlug, formData);
      setFeedback(result.ok ? { kind: "success", text: result.message ?? "Saved." } : { kind: "error", text: result.error });
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <form action={submit} className="space-y-2">
      <Label htmlFor="overage-budget">Monthly overage budget ({currency})</Label>
      <div className="flex max-w-sm items-center gap-2">
        <Input id="overage-budget" name="budget" inputMode="decimal" defaultValue={currentBudget} disabled={!canEdit} />
        {canEdit ? (
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
      {!canEdit ? <p className="text-xs text-stone-500">Only the organization owner can change the budget.</p> : null}
      <FeedbackText feedback={feedback} />
    </form>
  );
}
