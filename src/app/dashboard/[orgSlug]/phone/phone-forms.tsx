"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FeedbackText, type Feedback } from "@/components/ui/feedback";
import {
  addOptOut,
  removeOptOut,
  startOutboundCall,
  updatePhoneNumberSettings,
  type PhoneActionResult,
} from "@/server/actions/phone";
import { REMOVE_OPT_OUT_CONFIRMATION } from "@/lib/validation/phone";

const SELECT_CLASS = "w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900";

/** Runs a phone action from a form and shows its result; refreshes the page data on success. */
function useActionForm(action: (formData: FormData) => Promise<PhoneActionResult>, resetOnSuccess = false) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setFeedback(null);
    startTransition(async () => {
      const result = await action(formData);
      setFeedback(result.ok ? { kind: "success", text: result.message } : { kind: "error", text: result.error });
      if (result.ok) {
        if (resetOnSuccess) {
          form.reset();
        }
        router.refresh();
      }
    });
  }

  return { feedback, isPending, onSubmit };
}

export function NumberSettingsForm({
  orgSlug,
  number,
  agents,
  canEdit,
}: {
  orgSlug: string;
  number: { id: string; agentId: string | null; transferNumber: string | null; inboundEnabled: boolean; outboundEnabled: boolean };
  agents: Array<{ id: string; name: string }>;
  canEdit: boolean;
}) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) =>
    updatePhoneNumberSettings(orgSlug, number.id, formData)
  );
  const prefix = `number-${number.id}`;

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <fieldset disabled={!canEdit || isPending} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${prefix}-agent`} className="block">
              Agent that answers
            </Label>
            <select id={`${prefix}-agent`} name="agentId" defaultValue={number.agentId ?? ""} className={SELECT_CLASS}>
              <option value="">No agent (calls go to the transfer line)</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${prefix}-transfer`} className="block">
              Transfer line (a person)
            </Label>
            <Input
              id={`${prefix}-transfer`}
              name="transferNumber"
              inputMode="tel"
              placeholder="+233 24 123 4567"
              defaultValue={number.transferNumber ?? ""}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-stone-800">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="inboundEnabled" defaultChecked={number.inboundEnabled} />
            Answer incoming calls with the agent
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="outboundEnabled" defaultChecked={number.outboundEnabled} />
            Allow outbound calls from this number
          </label>
        </div>
        {canEdit ? (
          <Button type="submit" size="sm">
            {isPending ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </fieldset>
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function OutboundCallForm({
  orgSlug,
  numbers,
  leads,
}: {
  orgSlug: string;
  numbers: Array<{ id: string; label: string }>;
  leads: Array<{ id: string; label: string }>;
}) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => startOutboundCall(orgSlug, formData), true);

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="outbound-number" className="block">
            Call from
          </Label>
          <select id="outbound-number" name="phoneNumberId" className={SELECT_CLASS} required>
            {numbers.map((number) => (
              <option key={number.id} value={number.id}>
                {number.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="outbound-lead" className="block">
            Lead to call back
          </Label>
          <select id="outbound-lead" name="leadId" defaultValue="" className={SELECT_CLASS}>
            <option value="">— Enter a number instead —</option>
            {leads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="outbound-destination" className="block">
          Phone number (if not a lead)
        </Label>
        <Input id="outbound-destination" name="destination" inputMode="tel" placeholder="024 123 4567" />
      </div>
      <label className="flex items-start gap-2 text-sm text-stone-800">
        <input type="checkbox" name="requestConfirmed" className="mt-1" />
        <span>This person asked us to call them. (Needed when you type a number; recorded in the audit log.)</span>
      </label>
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Placing call…" : "Call now"}
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function AddOptOutForm({ orgSlug }: { orgSlug: string }) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => addOptOut(orgSlug, formData), true);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="opt-out-number" className="block">
            Add a number
          </Label>
          <Input id="opt-out-number" name="phoneNumber" inputMode="tel" placeholder="024 123 4567" required />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={isPending}>
          {isPending ? "Adding…" : "Add to do-not-call list"}
        </Button>
      </div>
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function RemoveOptOutForm({ orgSlug, optOutId }: { orgSlug: string; optOutId: string }) {
  const { feedback, isPending, onSubmit } = useActionForm((formData) => removeOptOut(orgSlug, optOutId, formData));
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Label htmlFor={`remove-${optOutId}`} className="sr-only">
        Type {REMOVE_OPT_OUT_CONFIRMATION} to remove
      </Label>
      <Input
        id={`remove-${optOutId}`}
        name="confirmation"
        placeholder={`Type ${REMOVE_OPT_OUT_CONFIRMATION}`}
        className="h-8 w-36"
        autoComplete="off"
      />
      <Button type="submit" size="sm" variant="outline" disabled={isPending}>
        Remove
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}
