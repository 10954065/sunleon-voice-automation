"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateAgentDraft } from "@/server/actions/agent";
import { VOICE_CATALOG } from "@/lib/voice";

const LANGUAGE_OPTIONS = [
  { code: "en", label: "English (Ghanaian)" },
  { code: "tw", label: "Twi (unvalidated)" },
  { code: "ga", label: "Ga (unvalidated)" },
  { code: "ee", label: "Ewe (unvalidated)" },
];

type DraftLike = {
  instructions: string;
  persona: string | null;
  tone: string | null;
  greeting: string | null;
  languages: string[];
  leadCaptureEnabled: boolean;
  voice: string;
} | null;

export function AgentDraftForm({
  orgSlug,
  agentId,
  draft,
  readOnly,
}: {
  orgSlug: string;
  agentId: string;
  draft: DraftLike;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateAgentDraft(orgSlug, agentId, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="instructions">Instructions</Label>
        <p className="text-xs text-stone-500">
          Sent to the caller&apos;s browser to configure each voice session. Don&apos;t include anything you
          wouldn&apos;t want a caller to see.
        </p>
        <textarea
          id="instructions"
          name="instructions"
          defaultValue={draft?.instructions ?? ""}
          disabled={readOnly}
          required
          rows={6}
          className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:opacity-60"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="persona">Persona</Label>
          <Input id="persona" name="persona" defaultValue={draft?.persona ?? ""} disabled={readOnly} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tone">Tone</Label>
          <Input id="tone" name="tone" defaultValue={draft?.tone ?? ""} disabled={readOnly} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="greeting">Greeting</Label>
        <Input id="greeting" name="greeting" defaultValue={draft?.greeting ?? ""} disabled={readOnly} />
      </div>
      <div className="space-y-2">
        <Label>Languages</Label>
        <div className="flex flex-wrap gap-4">
          {LANGUAGE_OPTIONS.map((lang) => (
            <label key={lang.code} className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                name="languages"
                value={lang.code}
                defaultChecked={draft?.languages?.includes(lang.code) ?? lang.code === "en"}
                disabled={readOnly}
              />
              {lang.label}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="voice">Voice</Label>
        <select
          id="voice"
          name="voice"
          defaultValue={draft?.voice ?? "marin"}
          disabled={readOnly}
          className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 disabled:opacity-60"
        >
          {VOICE_CATALOG.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.label}
              {voice.recommended ? " (recommended)" : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-stone-500">
          OpenAI built-in voices. None has been evaluated for Ghanaian English yet — test before publishing.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          name="leadCaptureEnabled"
          defaultChecked={draft?.leadCaptureEnabled ?? false}
          disabled={readOnly}
        />
        Capture leads during conversations
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {saved && !error ? <p className="text-sm text-emerald-600">Draft saved.</p> : null}
      {!readOnly ? (
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : "Save draft"}
        </Button>
      ) : null}
    </form>
  );
}
