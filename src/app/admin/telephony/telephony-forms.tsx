"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FeedbackText, type Feedback } from "@/components/ui/feedback";
import { registerPhoneNumber, releasePhoneNumber, type PhoneActionResult } from "@/server/actions/phone";

function useAdminForm(action: (formData: FormData) => Promise<PhoneActionResult>) {
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
        form.reset();
        router.refresh();
      }
    });
  }

  return { feedback, isPending, onSubmit };
}

export function RegisterNumberForm({ organizations }: { organizations: Array<{ slug: string; name: string }> }) {
  const { feedback, isPending, onSubmit } = useAdminForm(registerPhoneNumber);
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="register-e164" className="block">
            Number
          </Label>
          <Input id="register-e164" name="e164" inputMode="tel" placeholder="+233 30 123 4567" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="register-sid" className="block">
            Twilio number SID (optional)
          </Label>
          <Input id="register-sid" name="providerNumberSid" placeholder="PN…" autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="register-org" className="block">
            Organization
          </Label>
          <select
            id="register-org"
            name="organizationSlug"
            required
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
          >
            {organizations.map((organization) => (
              <option key={organization.slug} value={organization.slug}>
                {organization.name} ({organization.slug})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="register-label" className="block">
            Label (optional)
          </Label>
          <Input id="register-label" name="label" placeholder="Main line" />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Registering…" : "Register number"}
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}

export function ReleaseNumberButton({ phoneNumberId }: { phoneNumberId: string }) {
  const { feedback, isPending, onSubmit } = useAdminForm(() => releasePhoneNumber(phoneNumberId));
  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <Button type="submit" size="sm" variant="outline" disabled={isPending}>
        Release
      </Button>
      <FeedbackText feedback={feedback} />
    </form>
  );
}
