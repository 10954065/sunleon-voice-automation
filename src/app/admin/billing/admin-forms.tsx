"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assignPlan, createPlan, setVoiceCostRate, updatePlan, type AdminActionResult } from "@/server/actions/admin";

type Feedback = { kind: "error" | "success"; text: string } | null;

function useAdminAction(action: (formData: FormData) => Promise<AdminActionResult>) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await action(formData);
      setFeedback(result.ok ? { kind: "success", text: result.message ?? "Saved." } : { kind: "error", text: result.error });
      if (result.ok) {
        router.refresh();
      }
    });
  }

  const message = feedback ? (
    <p className={feedback.kind === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}>{feedback.text}</p>
  ) : null;
  return { submit, isPending, message };
}

export type PlanFormValues = {
  id?: string;
  code: string;
  name: string;
  price: string;
  includedMinutes: number;
  maxConcurrentSessions: number;
  maxAgents: number;
  overageRate: string;
  warningThresholdPercent: number;
  paystackPlanCode: string;
  isPublic: boolean;
  active: boolean;
  isTrial: boolean;
};

const NUMBER_FIELDS = [
  { name: "includedMinutes", label: "Included minutes" },
  { name: "maxConcurrentSessions", label: "Simultaneous sessions" },
  { name: "maxAgents", label: "Max agents" },
  { name: "warningThresholdPercent", label: "Warn at %" },
] as const;

export function PlanForm({ plan }: { plan?: PlanFormValues }) {
  const isNew = !plan?.id;
  const { submit, isPending, message } = useAdminAction((formData) =>
    isNew ? createPlan(formData) : updatePlan(plan.id as string, formData)
  );
  const prefix = plan?.id ?? "new";

  return (
    <form action={submit} className="space-y-3 rounded-md border border-stone-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {isNew ? (
          <div className="space-y-1">
            <Label htmlFor={`${prefix}-code`}>Code</Label>
            <Input id={`${prefix}-code`} name="code" placeholder="enterprise-acme" required />
          </div>
        ) : (
          <p className="self-end font-mono text-xs text-stone-500">
            {plan.code}
            {plan.isTrial ? " · trial" : ""}
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-name`}>Name</Label>
          <Input id={`${prefix}-name`} name="name" defaultValue={plan?.name} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-price`}>Price per month (GHS)</Label>
          <Input id={`${prefix}-price`} name="price" inputMode="decimal" defaultValue={plan?.price ?? "0.00"} required />
        </div>
        {NUMBER_FIELDS.map((field) => (
          <div key={field.name} className="space-y-1">
            <Label htmlFor={`${prefix}-${field.name}`}>{field.label}</Label>
            <Input
              id={`${prefix}-${field.name}`}
              name={field.name}
              type="number"
              min={field.name === "warningThresholdPercent" ? 1 : 0}
              defaultValue={plan ? plan[field.name] : field.name === "warningThresholdPercent" ? 80 : 0}
              required
            />
          </div>
        ))}
        <div className="space-y-1">
          <Label htmlFor={`${prefix}-overage`}>Overage per minute (GHS, blank = none)</Label>
          <Input id={`${prefix}-overage`} name="overageRate" inputMode="decimal" defaultValue={plan?.overageRate ?? ""} />
        </div>
        {plan?.isTrial ? null : (
          <div className="space-y-1">
            <Label htmlFor={`${prefix}-paystack`}>Paystack plan code</Label>
            <Input
              id={`${prefix}-paystack`}
              name="paystackPlanCode"
              placeholder="PLN_…"
              defaultValue={plan?.paystackPlanCode ?? ""}
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-stone-700">
        {plan?.isTrial ? null : (
          <label className="flex items-center gap-2">
            <input type="checkbox" name="isPublic" defaultChecked={plan ? plan.isPublic : false} />
            Self-serve (shown on Billing)
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" name="active" defaultChecked={plan ? plan.active : true} />
          Active
        </label>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving…" : isNew ? "Create plan" : "Save plan"}
        </Button>
      </div>
      {message}
    </form>
  );
}

export function CostRateForm({
  rate,
  current,
}: {
  rate: string;
  current: { ghsPerMinute: string; note: string } | null;
}) {
  const { submit, isPending, message } = useAdminAction(setVoiceCostRate);
  return (
    <form action={submit} className="space-y-3">
      <input type="hidden" name="rate" value={rate} />
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`cost-rate-${rate}`}>GHS per minute</Label>
          <Input
            id={`cost-rate-${rate}`}
            name="ghsPerMinute"
            inputMode="decimal"
            defaultValue={current?.ghsPerMinute ?? ""}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`cost-note-${rate}`}>Source of this number</Label>
          <Input
            id={`cost-note-${rate}`}
            name="note"
            defaultValue={current?.note ?? ""}
            placeholder="e.g. Gateway invoice, October 2026"
            required
          />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Saving…" : "Save cost rate"}
      </Button>
      {message}
    </form>
  );
}

export function AssignPlanForm({
  organizationId,
  plans,
}: {
  organizationId: string;
  plans: Array<{ id: string; name: string }>;
}) {
  const { submit, isPending, message } = useAdminAction(assignPlan);
  return (
    <form action={submit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <select
        name="planId"
        aria-label="Plan"
        className="h-9 rounded-md border border-stone-300 bg-white px-2 text-sm"
        required
        defaultValue=""
      >
        <option value="" disabled>
          Plan…
        </option>
        {plans.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.name}
          </option>
        ))}
      </select>
      <Input name="months" type="number" min={1} max={24} defaultValue={1} aria-label="Months" className="h-9 w-20" />
      <Button type="submit" size="sm" variant="outline" disabled={isPending}>
        {isPending ? "Assigning…" : "Assign"}
      </Button>
      {message}
    </form>
  );
}
