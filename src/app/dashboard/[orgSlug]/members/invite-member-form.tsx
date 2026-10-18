"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteMember } from "@/server/actions/membership";

export function InviteMemberForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await inviteMember(orgSlug, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <form action={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="role">Role</Label>
        <select
          id="role"
          name="role"
          defaultValue="AGENT_MANAGER"
          className="h-10 rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900"
        >
          <option value="ADMIN">Admin</option>
          <option value="AGENT_MANAGER">Agent Manager</option>
          <option value="ANALYST">Analyst</option>
        </select>
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Adding…" : "Add member"}
      </Button>
      {error ? <p className="w-full text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
