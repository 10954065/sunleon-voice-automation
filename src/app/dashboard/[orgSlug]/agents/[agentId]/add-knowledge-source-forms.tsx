"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createFaqSource,
  createFileSource,
  createManualSource,
  createUrlSource,
} from "@/server/actions/knowledge";

type SourceKind = "faq" | "manual" | "url" | "file";

const TABS: { key: SourceKind; label: string }[] = [
  { key: "faq", label: "FAQ" },
  { key: "manual", label: "Text" },
  { key: "url", label: "Website" },
  { key: "file", label: "File" },
];

export function AddKnowledgeSourceForms({
  orgSlug,
  agentId,
}: {
  orgSlug: string;
  agentId: string;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SourceKind>("faq");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    formData.set("agentId", agentId);
    setError(null);
    startTransition(async () => {
      const action = {
        faq: createFaqSource,
        manual: createManualSource,
        url: createUrlSource,
        file: createFileSource,
      }[activeTab];

      const result = await action(orgSlug, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add knowledge</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                activeTab === tab.key ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form action={handleSubmit} className="space-y-4">
          {activeTab === "faq" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="faq-title">Title</Label>
                <Input id="faq-title" name="title" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="faq-question">Question</Label>
                <Input id="faq-question" name="question" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="faq-answer">Answer</Label>
                <textarea
                  id="faq-answer"
                  name="answer"
                  required
                  rows={3}
                  className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
                />
              </div>
            </>
          ) : null}

          {activeTab === "manual" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="manual-title">Title</Label>
                <Input id="manual-title" name="title" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-content">Content</Label>
                <textarea
                  id="manual-content"
                  name="content"
                  required
                  rows={5}
                  className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
                />
              </div>
            </>
          ) : null}

          {activeTab === "url" ? (
            <div className="space-y-2">
              <Label htmlFor="url">Website URL</Label>
              <Input id="url" name="url" type="url" placeholder="https://example.com/faq" required />
              <p className="text-xs text-stone-500">
                Crawled once immediately — not kept in sync automatically yet.
              </p>
            </div>
          ) : null}

          {activeTab === "file" ? (
            <div className="space-y-2">
              <Label htmlFor="file">File (PDF, DOCX, TXT, MD, or CSV — max 10 MB)</Label>
              <input
                id="file"
                name="file"
                type="file"
                accept=".pdf,.docx,.txt,.md,.csv"
                required
                className="block w-full text-sm text-stone-700"
              />
            </div>
          ) : null}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={isPending}>
            {isPending ? "Adding…" : "Add"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
