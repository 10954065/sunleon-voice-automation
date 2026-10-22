"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAgent } from "@/server/actions/agent";

export function CreateAgentForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createAgent(orgSlug, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/dashboard/${orgSlug}/agents/${result.agentId}`);
    });
  }

  return (
    <form action={handleSubmit} className="flex items-end gap-3">
      <div className="flex-1 space-y-2">
        <Label htmlFor="agent-name">Agent name</Label>
        <Input id="agent-name" name="name" placeholder="e.g. Support Assistant" required />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating…" : "Create agent"}
      </Button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
