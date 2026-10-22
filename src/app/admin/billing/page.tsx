import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/server/db/client";
import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";
import { getCostReport } from "@/server/billing/report";
import { VOICE_PROVIDER_ID } from "@/server/billing/usage";
import { isPaymentConfigured } from "@/server/billing/paystack";
import { REALTIME_VOICE_MODEL } from "@/lib/voice";
import { formatMicros, formatMinutes, formatMoney, minorToMajorString } from "@/lib/billing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AssignPlanForm, CostRateForm, PlanForm } from "./admin-forms";

export const instant = false;

const RECENT_EVENT_LIMIT = 20;

function formatDate(date: Date): string {
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

export default async function AdminBillingPage() {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    // Don't reveal that the console exists to anyone who isn't a platform admin.
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }

  const [plans, costRate, report, events, rejected] = await Promise.all([
    prisma.plan.findMany({ orderBy: [{ isTrial: "desc" }, { priceMinor: "asc" }] }),
    prisma.providerCostRate.findUnique({
      where: {
        metric_provider_model: { metric: "VOICE_SECONDS", provider: VOICE_PROVIDER_ID, model: REALTIME_VOICE_MODEL },
      },
    }),
    getCostReport(),
    prisma.paymentWebhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: RECENT_EVENT_LIMIT }),
    prisma.billingTransaction.findMany({
      where: { status: "REJECTED" },
      orderBy: { createdAt: "desc" },
      take: RECENT_EVENT_LIMIT,
      include: { organization: { select: { name: true } } },
    }),
  ]);

  const assignablePlans = plans.filter((plan) => plan.active && !plan.isTrial).map(({ id, name }) => ({ id, name }));
  const totals = report.reduce(
    (sum, row) => ({
      usedSeconds: sum.usedSeconds + row.usedSeconds,
      costMicros: sum.costMicros + row.estimatedCostMicros,
      revenueMinor: sum.revenueMinor + row.revenueMinor,
      unpricedSeconds: sum.unpricedSeconds + row.unpricedSeconds,
    }),
    { usedSeconds: 0, costMicros: 0, revenueMinor: 0, unpricedSeconds: 0 }
  );

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <Link href="/dashboard" className="text-sm text-stone-500 hover:text-stone-700">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-stone-950">Platform billing</h1>
        <p className="mt-1 text-sm text-stone-500">
          Cross-tenant view for platform admins. Costs are estimates from the configured rate, not provider invoices.
          Paystack: {isPaymentConfigured() ? "configured" : "NOT configured (checkout and webhooks are blocked)"}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Voice cost rate</CardTitle>
          <CardDescription>
            {costRate
              ? `Currently ${formatMicros(costRate.microsPerUnit * 60, "GHS")} per minute for ${REALTIME_VOICE_MODEL} — source: ${costRate.note}.`
              : "No rate is set, so usage is recorded without a cost estimate and margins can't be computed. Enter a rate measured from real provider charges."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CostRateForm
            current={
              costRate ? { ghsPerMinute: ((costRate.microsPerUnit * 60) / 1_000_000).toFixed(4), note: costRate.note } : null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current-period report</CardTitle>
          <CardDescription>
            Totals across the {report.length} most recent organizations: {formatMinutes(totals.usedSeconds)} used ·
            estimated cost {formatMicros(totals.costMicros, "GHS")}
            {totals.unpricedSeconds > 0 ? ` (+ ${formatMinutes(totals.unpricedSeconds)} unpriced)` : ""} · revenue{" "}
            {formatMoney(totals.revenueMinor, "GHS")}.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-stone-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Organization</th>
                <th className="py-2 pr-4 font-medium">Plan</th>
                <th className="py-2 pr-4 font-medium">Used</th>
                <th className="py-2 pr-4 font-medium">Est. cost</th>
                <th className="py-2 pr-4 font-medium">Revenue</th>
                <th className="py-2 pr-4 font-medium">Margin</th>
                <th className="py-2 font-medium">Assign plan (manual)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 align-top text-stone-700">
              {report.map((row) => (
                <tr key={row.organizationId}>
                  <td className="py-2 pr-4">
                    {row.name}
                    <span className="block font-mono text-xs text-stone-400">{row.slug}</span>
                  </td>
                  <td className="py-2 pr-4">
                    {row.entitlements.plan?.name ?? "none"}
                    <span className="block text-xs text-stone-500">
                      {row.entitlements.source}
                      {row.entitlements.subscriptionStatus ? ` · ${row.entitlements.subscriptionStatus.toLowerCase()}` : ""}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {formatMinutes(row.usedSeconds)} / {formatMinutes(row.entitlements.includedSeconds)}
                  </td>
                  <td className="py-2 pr-4">
                    {formatMicros(row.estimatedCostMicros, "GHS")}
                    {row.unpricedSeconds > 0 ? (
                      <span className="block text-xs text-amber-700">{formatMinutes(row.unpricedSeconds)} unpriced</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">{formatMoney(row.revenueMinor, "GHS")}</td>
                  <td className="py-2 pr-4">{row.marginMicros === null ? "unknown" : formatMicros(row.marginMicros, "GHS")}</td>
                  <td className="py-2">
                    <AssignPlanForm organizationId={row.organizationId} plans={assignablePlans} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>
            Changes apply to every organization on the plan from its next check. Link a plan to Paystack by creating the
            same plan (amount, monthly interval, GHS) in the Paystack dashboard and pasting its PLN_ code here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {plans.map((plan) => (
            <PlanForm
              key={plan.id}
              plan={{
                id: plan.id,
                code: plan.code,
                name: plan.name,
                price: minorToMajorString(plan.priceMinor),
                includedMinutes: plan.includedMinutes,
                maxConcurrentSessions: plan.maxConcurrentSessions,
                maxAgents: plan.maxAgents,
                overageRate: plan.overageRateMinorPerMinute ? minorToMajorString(plan.overageRateMinorPerMinute) : "",
                warningThresholdPercent: plan.warningThresholdPercent,
                paystackPlanCode: plan.paystackPlanCode ?? "",
                isPublic: plan.isPublic,
                active: plan.active,
                isTrial: plan.isTrial,
              }}
            />
          ))}
          <div>
            <p className="mb-2 text-sm font-medium text-stone-900">New custom plan</p>
            <PlanForm />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Paystack events</CardTitle>
          <CardDescription>Verified, de-duplicated webhook deliveries. Unverified requests are never stored.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-stone-600">No events received yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm text-stone-700">
              {events.map((event) => (
                <li key={event.id} className="py-2">
                  <span className="font-mono text-xs">{event.eventType}</span> · {event.status.toLowerCase()} ·{" "}
                  {formatDate(event.receivedAt)}
                  {event.note ? <span className="block text-xs text-stone-500">{event.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {rejected.length > 0 ? (
            <div className="mt-4 space-y-1">
              <p className="text-sm font-medium text-red-700">Payments rejected for not matching the plan</p>
              {rejected.map((transaction) => (
                <p key={transaction.id} className="text-xs text-stone-600">
                  {transaction.organization.name} · {transaction.reference} · {transaction.failureReason}
                </p>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
