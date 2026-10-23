"use client";

import { Button } from "@/components/ui/button";

/**
 * Fallback for unexpected errors below the root layout. Server-side errors are already recorded by
 * src/instrumentation.ts; the reference shown here is the error's digest, which matches the
 * ErrorReport row on /admin/monitoring. No error details are shown to the visitor.
 */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const digest =
    typeof error === "object" && error !== null && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <main className="mx-auto max-w-lg space-y-4 px-6 py-16">
      <h1 className="text-xl font-semibold text-stone-950">Something went wrong</h1>
      <p className="text-sm text-stone-600">
        The page couldn&apos;t be loaded. It has been reported. Try again, and if it keeps happening, contact
        Sunleon support{digest ? " with the reference below" : ""}.
      </p>
      {digest ? <p className="font-mono text-xs text-stone-500">Reference: {digest}</p> : null}
      <Button type="button" variant="outline" onClick={() => retry()}>
        Try again
      </Button>
    </main>
  );
}
