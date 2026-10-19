"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { publishAgentVersion, rollbackAgentVersion } from "@/server/actions/agent";

export function PublishControls({
  orgSlug,
  agentId,
  hasDraft,
  currentPublishedVersionId,
  publishedVersions,
  canRollback,
}: {
  orgSlug: string;
  agentId: string;
  hasDraft: boolean;
  currentPublishedVersionId: string | null;
  publishedVersions: { id: string; versionNumber: number; publishedAt: string }[];
  canRollback: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handlePublish() {
    setError(null);
    startTransition(async () => {
      const result = await publishAgentVersion(orgSlug, agentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleRollback(versionId: string) {
    setError(null);
    startTransition(async () => {
      const result = await rollbackAgentVersion(orgSlug, agentId, versionId);
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
        <CardTitle>Publish</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handlePublish} disabled={isPending || !hasDraft}>
          {isPending ? "Working…" : "Publish draft"}
        </Button>
        {!hasDraft ? (
          <p className="text-sm text-stone-500">No unpublished changes right now.</p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {publishedVersions.length > 0 ? (
          <div className="space-y-2 border-t border-stone-100 pt-4">
            <p className="text-sm font-medium text-stone-700">Published history</p>
            {publishedVersions.map((version) => (
              <div key={version.id} className="flex items-center justify-between text-sm">
                <span className="text-stone-600">
                  v{version.versionNumber} · {new Date(version.publishedAt).toLocaleString()}
                  {version.id === currentPublishedVersionId ? " (live)" : ""}
                </span>
                {canRollback && version.id !== currentPublishedVersionId ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRollback(version.id)}
                    disabled={isPending}
                  >
                    Roll back
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
