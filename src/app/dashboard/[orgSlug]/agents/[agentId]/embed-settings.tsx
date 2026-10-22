"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateEmbedDomains } from "@/server/actions/agent";

type Props = {
  orgSlug: string;
  agentId: string;
  businessName: string;
  appUrl: string;
  allowedDomains: string[];
  isPublished: boolean;
  canEditDomains: boolean;
};

export function EmbedSettings({
  orgSlug,
  agentId,
  businessName,
  appUrl,
  allowedDomains,
  isPublished,
  canEditDomains,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const snippet =
    `<iframe src="${appUrl}/widget/${agentId}" title="Voice assistant for ${businessName.replace(/"/g, "&quot;")}" ` +
    `allow="microphone" loading="lazy" style="width:360px;height:520px;border:0;border-radius:12px"></iframe>`;

  function handleSubmit(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateEmbedDomains(orgSlug, agentId, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-5">
      <form action={handleSubmit} className="space-y-2">
        <Label htmlFor="domains">Allowed websites</Label>
        <p className="text-xs text-stone-500">
          One hostname per line, e.g. <code>www.example.com.gh</code>. The widget only starts sessions when it is
          embedded on one of these exact hostnames. Leave empty to block all embedding.
        </p>
        <textarea
          id="domains"
          name="domains"
          rows={3}
          defaultValue={allowedDomains.join("\n")}
          disabled={!canEditDomains}
          className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-sm text-stone-900 disabled:opacity-60"
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {saved && !error ? <p className="text-sm text-emerald-600">Allowed websites saved.</p> : null}
        {canEditDomains ? (
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Saving…" : "Save allowed websites"}
          </Button>
        ) : (
          <p className="text-xs text-stone-500">Only owners and admins can change where the widget may run.</p>
        )}
      </form>

      <div className="space-y-2">
        <Label>Embed snippet</Label>
        {!isPublished ? (
          <p className="text-sm text-stone-600">Publish this agent to get an embed snippet.</p>
        ) : allowedDomains.length === 0 ? (
          <p className="text-sm text-stone-600">Add at least one allowed website to get an embed snippet.</p>
        ) : (
          <>
            <pre className="overflow-x-auto rounded-md bg-stone-900 p-3 text-xs text-stone-100">{snippet}</pre>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => void copySnippet()}>
                {copied ? "Copied" : "Copy snippet"}
              </Button>
              <p className="text-xs text-stone-500">
                Keep <code>allow=&quot;microphone&quot;</code>, and don&apos;t add <code>referrerpolicy=&quot;no-referrer&quot;</code> —
                the widget needs it to confirm which site it&apos;s on.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
