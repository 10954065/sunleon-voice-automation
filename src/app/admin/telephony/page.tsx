import { notFound } from "next/navigation";

import { prisma } from "@/server/db/client";
import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";
import { getPublicBaseUrl } from "@/server/telephony/config";
import { getTelephonyReadiness } from "@/server/telephony/queries";
import { getTelephonyReconciliationReport } from "@/server/telephony/reconciliation";
import { formatDateTime, formatDuration } from "@/lib/format";
import { rangeForDays } from "@/lib/validation/history";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RegisterNumberForm, ReleaseNumberButton } from "./telephony-forms";

export const instant = false;

const REPORT_DAYS = 30;
const ORGANIZATION_OPTION_LIMIT = 200;

type MismatchDetails = { mismatches?: Array<{ conversationId: string; callbackSeconds: number; carrierSeconds: number }> };

export default async function AdminTelephonyPage() {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }

  const since = rangeForDays(REPORT_DAYS).from;
  const [numbers, organizations, report, lastRun] = await Promise.all([
    prisma.phoneNumber.findMany({
      orderBy: { createdAt: "asc" },
      include: { organization: { select: { name: true } }, agent: { select: { name: true } } },
    }),
    prisma.organization.findMany({
      orderBy: { name: "asc" },
      take: ORGANIZATION_OPTION_LIMIT,
      select: { slug: true, name: true },
    }),
    getTelephonyReconciliationReport(since),
    prisma.jobRun.findFirst({ where: { job: "reconcile-telephony" }, orderBy: { startedAt: "desc" } }),
  ]);
  const readiness = getTelephonyReadiness();
  const baseUrl = getPublicBaseUrl() ?? "https://<your-app>";
  const mismatches = ((lastRun?.details ?? {}) as MismatchDetails).mismatches ?? [];

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Telephony</h1>
        <p className="mt-1 text-sm text-stone-500">
          Twilio: {readiness.twilio ? "configured" : "NOT configured"} · OpenAI Realtime SIP:{" "}
          {readiness.realtimeSip ? "configured" : "NOT configured"} · public URL:{" "}
          {readiness.publicUrl ? "configured" : "NOT configured"}. No call can connect until all three are set.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Provider setup</CardTitle>
          <CardDescription>Paste these into each provider. Every request is verified by its signature.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="font-medium text-stone-900">Twilio number → Voice → “A call comes in” (HTTP POST)</dt>
              <dd className="font-mono text-xs text-stone-700">{baseUrl}/api/telephony/twilio/voice</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-900">Twilio number → “Call status changes” (HTTP POST)</dt>
              <dd className="font-mono text-xs text-stone-700">{baseUrl}/api/telephony/twilio/status</dd>
            </div>
            <div>
              <dt className="font-medium text-stone-900">OpenAI project → Webhooks → realtime.call.incoming</dt>
              <dd className="font-mono text-xs text-stone-700">{baseUrl}/api/telephony/openai</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Register a number</CardTitle>
          <CardDescription>
            Buy and verify the number in Twilio first (Ghana numbers need the business&apos;s registration documents and a
            Ghana address), then assign it here. The organization chooses which agent answers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RegisterNumberForm organizations={organizations} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Numbers</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {numbers.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No numbers registered.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-stone-200 text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Number</th>
                  <th className="px-4 py-2 font-medium">Organization</th>
                  <th className="px-4 py-2 font-medium">Agent</th>
                  <th className="px-4 py-2 font-medium">Inbound / outbound</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {numbers.map((number) => (
                  <tr key={number.id}>
                    <td className="px-4 py-2 text-stone-900">{number.e164}</td>
                    <td className="px-4 py-2 text-stone-700">{number.organization.name}</td>
                    <td className="px-4 py-2 text-stone-700">{number.agent?.name ?? "—"}</td>
                    <td className="px-4 py-2 text-stone-700">
                      {number.inboundEnabled ? "on" : "off"} / {number.outboundEnabled ? "on" : "off"}
                    </td>
                    <td className="px-4 py-2">
                      <ReleaseNumberButton phoneNumberId={number.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage reconciliation (last {REPORT_DAYS} days)</CardTitle>
          <CardDescription>
            AI billed is what organizations were charged; AI leg is Twilio&apos;s measurement of the AI side of each call.
            Carrier ledger vs carrier records compares our cost record with Twilio&apos;s. Unreconciled calls haven&apos;t
            been checked against Twilio&apos;s call records yet (daily job). See docs/USAGE_RECONCILIATION.md.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-stone-600">
            Last reconciliation run:{" "}
            {lastRun ? `${formatDateTime(lastRun.startedAt)} (${lastRun.status.toLowerCase()})` : "never"}.
            {mismatches.length > 0 ? ` ${mismatches.length} duration mismatch(es) in that run.` : ""}
          </p>
          {report.length === 0 ? (
            <p className="text-sm text-stone-500">No phone calls in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-200 text-xs uppercase text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Organization</th>
                    <th className="px-3 py-2 font-medium">Calls</th>
                    <th className="px-3 py-2 font-medium">AI billed</th>
                    <th className="px-3 py-2 font-medium">AI leg (Twilio)</th>
                    <th className="px-3 py-2 font-medium">Carrier ledger</th>
                    <th className="px-3 py-2 font-medium">Carrier records</th>
                    <th className="px-3 py-2 font-medium">Unreconciled</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {report.map((row) => (
                    <tr key={row.organizationId}>
                      <td className="px-3 py-2 text-stone-900">{row.name}</td>
                      <td className="px-3 py-2 text-stone-700">{row.calls}</td>
                      <td className="px-3 py-2 text-stone-700">{formatDuration(row.aiBilledSeconds)}</td>
                      <td className="px-3 py-2 text-stone-700">{formatDuration(row.aiLegSeconds)}</td>
                      <td className="px-3 py-2 text-stone-700">{formatDuration(row.carrierLedgerSeconds)}</td>
                      <td className="px-3 py-2 text-stone-700">{formatDuration(row.carrierSeconds)}</td>
                      <td className="px-3 py-2 text-stone-700">{row.unreconciled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {mismatches.length > 0 ? (
            <ul className="space-y-1 text-xs text-stone-600">
              {mismatches.map((mismatch) => (
                <li key={mismatch.conversationId}>
                  {mismatch.conversationId}: callback {formatDuration(mismatch.callbackSeconds)}, Twilio record{" "}
                  {formatDuration(mismatch.carrierSeconds)}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
