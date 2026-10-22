"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = { conversationId: string; businessName: string };

export function LeadCaptureForm({ conversationId, businessName }: Props) {
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus("submitting");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/voice/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          name: String(form.get("name") ?? ""),
          phone: String(form.get("phone") ?? ""),
          email: String(form.get("email") ?? ""),
          note: String(form.get("note") ?? ""),
        }),
      });
      const result = await response.json().catch(() => ({ ok: false, error: "Something went wrong." }));
      if (!response.ok || !result.ok) {
        setError(result.error ?? "Could not send your details.");
        setStatus("idle");
        return;
      }
      setStatus("sent");
    } catch {
      setError("Could not send your details. Check your connection and try again.");
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <p role="status" className="text-sm text-emerald-700">
        Thanks — {businessName} has your details and can follow up with you.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Share your contact details">
      <p className="text-sm text-stone-700">
        Want someone from {businessName} to follow up? Share your details. Provide at least a name, phone, or email.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="lead-name">Name</Label>
          <Input id="lead-name" name="name" autoComplete="name" maxLength={200} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lead-phone">Phone</Label>
          <Input id="lead-phone" name="phone" type="tel" autoComplete="tel" maxLength={50} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="lead-email">Email</Label>
        <Input id="lead-email" name="email" type="email" autoComplete="email" maxLength={200} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="lead-note">Anything we should know?</Label>
        <Input id="lead-note" name="note" maxLength={2000} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={status === "submitting"}>
        {status === "submitting" ? "Sending…" : "Send my details"}
      </Button>
    </form>
  );
}
