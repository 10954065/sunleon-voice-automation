import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";
import { getMonitoringSnapshot } from "@/server/admin/overview";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const instant = false;

function Indicator({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-stone-200 bg-white p-4">
      <span aria-hidden="true" className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      <div>
        <p className="text-sm font-medium text-stone-900">
          {label} <span className="sr-only">{ok ? "(healthy)" : "(needs attention)"}</span>
        </p>
        <p className="text-xs text-stone-500">{detail}</p>
      </div>
    </div>
  );
}

function Count({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${warn && value > 0 ? "text-red-700" : "text-stone-950"}`}>{value}</p>
    </div>
  );
}

export default async function MonitoringPage() {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }
  const snapshot = await getMonitoringSnapshot();

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Monitoring</h1>
        <p className="mt-1 text-sm text-stone-500">
          Checked {formatDateTime(snapshot.checkedAt)}. Built from recorded errors, job runs and session rows. There is
          no external error tracker or alerting yet: someone has to look at this page.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Indicator ok={snapshot.database} label="Database" detail={snapshot.database ? "Reachable" : "Not reachable"} />
        <Indicator
          ok={snapshot.configuration.aiGateway}
          label="AI Gateway key"
          detail={snapshot.configuration.aiGateway ? "Configured" : "Missing — voice, embeddings and summaries are blocked"}
        />
        <Indicator
          ok={snapshot.configuration.paystack}
          label="Paystack key"
          detail={snapshot.configuration.paystack ? "Configured" : "Missing — online payments are blocked"}
        />
        <Indicator
          ok={snapshot.configuration.cronSecret}
          label="Cron secret"
          detail={snapshot.configuration.cronSecret ? "Configured" : "Missing — scheduled jobs refuse to run"}
        />
        {snapshot.jobs.map((job) => (
          <Indicator
            key={job.job}
            ok={!job.stale && job.lastRun?.status !== "FAILED"}
            label={`Job: ${job.job}`}
            detail={
              job.lastRun
                ? `Last run ${formatDateTime(job.lastRun.startedAt)} (${job.lastRun.status.toLowerCase()})${
                    job.lastSuccess ? `; last success ${formatDateTime(job.lastSuccess.startedAt)}` : "; never succeeded"
                  }`
                : "Has never run"
            }
          />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Count label="Errors (24h)" value={snapshot.errors24h} warn />
        <Count label="Failed sessions (24h)" value={snapshot.failedConversations24h} warn />
        <Count label="Session errors (24h)" value={snapshot.errorEvents24h} warn />
        <Count label="Stuck sessions" value={snapshot.stuckSessions} warn />
        <Count label="Failed knowledge sources" value={snapshot.failedKnowledgeSources} warn />
        <Count label="Rejected/failed payments (7d)" value={snapshot.problemTransactions7d} warn />
      </div>
      <p className="text-xs text-stone-500">
        Paystack webhooks in the last 7 days: {snapshot.webhooks7d.processed} processed, {snapshot.webhooks7d.ignored} ignored.
        Stuck sessions are active longer than any session can last; the sweep job closes them.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Server errors</CardTitle>
          <CardDescription>
            Grouped by fingerprint, newest first. Messages are scrubbed of emails, phone numbers and credentials before
            storage. The reference shown to users is the digest.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.errorReports.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No errors recorded.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {snapshot.errorReports.map((report) => (
                <li key={report.id} className="space-y-1 px-6 py-3 text-sm">
                  <p className="font-mono text-xs text-stone-900">{report.message}</p>
                  <p className="text-xs text-stone-500">
                    {report.source}
                    {report.route ? ` · ${report.route}` : ""} · {report.occurrences}× · last {formatDateTime(report.lastSeenAt)} ·
                    first {formatDateTime(report.firstSeenAt)}
                    {report.digest ? ` · digest ${report.digest}` : ""}
                  </p>
                  {report.stack ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-stone-500">Stack</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-50 p-2 text-xs text-stone-700">{report.stack}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent failed sessions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {snapshot.recentFailures.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No failed sessions.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {snapshot.recentFailures.map((failure) => (
                <li key={failure.id} className="px-6 py-3 text-sm">
                  <p className="text-stone-900">
                    {failure.organization.name} · {failure.channel === "TEST" ? "dashboard test" : "website"}
                  </p>
                  <p className="text-xs text-stone-500">
                    {failure.endedAt ? formatDateTime(failure.endedAt) : "—"} · {failure.closeReason?.replace(/_/g, " ") ?? "—"}
                  </p>
                  {failure.errorMessage ? <p className="text-xs text-red-700">{failure.errorMessage}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
