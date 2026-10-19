"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deleteKnowledgeSource, retryKnowledgeSource } from "@/server/actions/knowledge";

type Source = {
  id: string;
  type: string;
  title: string;
  status: string;
  errorMessage: string | null;
};

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-stone-100 text-stone-600",
  PROCESSING: "bg-amber-100 text-amber-700",
  READY: "bg-emerald-100 text-emerald-700",
  FAILED: "bg-red-100 text-red-700",
};

export function KnowledgeSourcesList({
  orgSlug,
  sources,
  canManage,
}: {
  orgSlug: string;
  sources: Source[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRetry(sourceId: string) {
    startTransition(async () => {
      await retryKnowledgeSource(orgSlug, sourceId);
      router.refresh();
    });
  }

  function handleDelete(sourceId: string) {
    startTransition(async () => {
      await deleteKnowledgeSource(orgSlug, sourceId);
      router.refresh();
    });
  }

  if (sources.length === 0) {
    return <p className="text-sm text-stone-500">No knowledge sources yet.</p>;
  }

  return (
    <Card>
      <CardContent className="divide-y divide-stone-100 p-0">
        {sources.map((source) => (
          <div key={source.id} className="flex items-center justify-between gap-4 px-6 py-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-stone-950">{source.title}</p>
              <p className="text-xs text-stone-500">
                {source.type}
                {source.status === "FAILED" && source.errorMessage
                  ? ` — ${source.errorMessage}`
                  : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[source.status] ?? ""}`}
              >
                {source.status}
              </span>
              {canManage && source.status === "FAILED" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => handleRetry(source.id)}
                >
                  Retry
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => handleDelete(source.id)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
