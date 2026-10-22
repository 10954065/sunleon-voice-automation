import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { getUsageSummary } from "@/server/billing/usage";
import { isPaymentConfigured } from "@/server/billing/paystack";
import { formatMinutes, formatMoney, minorToMajorString, planLabel } from "@/lib/billing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CancelSubscriptionButton, ChoosePlanButton, ConfirmPayment, OverageBudgetForm } from "./billing-controls";
import type { Subscription } from "@/generated/prisma/client";

export const instant = false;

const HISTORY_LIMIT = 20;

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function subscriptionStatusText(subscription: Subscription): string {
  const until = formatDate(subscription.paidThroughAt);
  switch (subscription.status) {
    case "ACTIVE":
      return subscription.provider === "MANUAL" ? `Active until ${until}` : `Active — renews ${until}`;
    case "NON_RENEWING":
      return `Not renewing — active until ${until}`;
    case "PAST_DUE":
      return `Renewal payment failed — active until ${until}`;
    case "CANCELED":
      return `Cancelled — active until ${until}`;
  }
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ reference?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const { reference } = await searchParams;
  const context = await requireOrgContext(orgSlug);
  const organizationId = context.organization.id;
  const canManage = context.role === "OWNER" || context.role === "ADMIN" || context.role === "SUPER_ADMIN";
  const isOwner = context.role === "OWNER" || context.role === "SUPER_ADMIN";

  const [summary, organization, subscription, plans, transactions] = await Promise.all([
    getUsageSummary(organizationId),
    // The owner's saved budget, not the effective one (trials always run with no overage).
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { overageBudgetMinor: true } }),
    prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } }),
    prisma.plan.findMany({
      where: { active: true, isPublic: true, isTrial: false },
      orderBy: { priceMinor: "asc" },
    }),
    prisma.billingTransaction.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { plan: { select: { name: true } } },
    }),
  ]);

  const { entitlements } = summary;
  const paymentsConfigured = isPaymentConfigured();
  const returnReference = typeof reference === "string" && reference.startsWith("slv_") ? reference : null;
  const renewing = subscription && (subscription.status === "ACTIVE" || subscription.status === "PAST_DUE");
  const usedPercent = Math.min(100, summary.percentUsed);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Billing & usage</h1>
        <p className="mt-1 text-sm text-stone-500">
          Prices and allowances are illustrative while real provider costs are measured.
        </p>
      </div>

      {returnReference && canManage ? <ConfirmPayment orgSlug={orgSlug} reference={returnReference} /> : null}

      {summary.warning !== "none" ? (
        <div
          role="status"
          className={
            summary.warning === "exhausted"
              ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              : "rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          }
        >
          {summary.warning === "exhausted"
            ? entitlements.overageAllowanceSeconds > 0
              ? "Your included minutes are used up. Calls continue within your overage budget."
              : "Your included minutes are used up. New voice sessions are paused until the next period, a plan change, or an overage budget."
            : `You've used ${summary.percentUsed}% of this period's included minutes.`}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            {entitlements.plan ? planLabel(entitlements.plan.name, entitlements.source === "trial") : "No active plan"}
          </CardTitle>
          <CardDescription>
            {entitlements.source === "subscription" && subscription
              ? subscriptionStatusText(subscription)
              : entitlements.source === "trial" && entitlements.periodEnd
                ? `Trial ends ${formatDate(entitlements.periodEnd)}.`
                : "Voice sessions are paused. Choose a plan below."}
          </CardDescription>
        </CardHeader>
        {entitlements.plan ? (
          <CardContent className="space-y-1 text-sm text-stone-700">
            <p>
              {entitlements.plan.includedMinutes} included minutes · up to {entitlements.maxConcurrentSessions} simultaneous
              session{entitlements.maxConcurrentSessions === 1 ? "" : "s"} · up to {entitlements.maxAgents} agent
              {entitlements.maxAgents === 1 ? "" : "s"}
            </p>
            {renewing && isOwner ? (
              <div className="pt-3">
                <CancelSubscriptionButton orgSlug={orgSlug} paidThrough={formatDate(subscription.paidThroughAt)} />
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage this period</CardTitle>
          <CardDescription>
            {entitlements.periodStart && entitlements.periodEnd
              ? `${formatDate(entitlements.periodStart)} – ${formatDate(entitlements.periodEnd)}. Measured by our server from session start to end.`
              : "No billing period is active."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-stone-700">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-stone-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
            aria-label="Included minutes used"
          >
            <div
              className={usedPercent >= 100 ? "h-full bg-red-500" : usedPercent >= 80 ? "h-full bg-amber-500" : "h-full bg-emerald-600"}
              style={{ width: `${usedPercent}%` }}
            />
          </div>
          <p>
            {formatMinutes(summary.usedSeconds)} used of {formatMinutes(entitlements.includedSeconds)} included
            {summary.liveSessions > 0
              ? ` · ${summary.liveSessions} live session${summary.liveSessions === 1 ? "" : "s"} holding ${formatMinutes(summary.reservedSeconds)}`
              : ""}
            {" · "}
            {formatMinutes(summary.remainingSeconds)} available to start new sessions
          </p>
          {summary.overageSeconds > 0 ? (
            <p>
              Overage: {formatMinutes(summary.overageSeconds)} ·{" "}
              {formatMoney(summary.overageChargeMinor, entitlements.currency)} to be invoiced (capped at your budget)
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Overage budget</CardTitle>
          <CardDescription>
            {entitlements.overageRateMinorPerMinute
              ? `After your included minutes, calls continue at ${formatMoney(entitlements.overageRateMinorPerMinute, entitlements.currency)} per minute until this budget is spent. 0 stops calls at your included minutes. Overage is invoiced separately.`
              : "Your current plan doesn't allow overage: voice sessions stop when the included minutes are used up."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OverageBudgetForm
            key={organization.overageBudgetMinor}
            orgSlug={orgSlug}
            currentBudget={minorToMajorString(organization.overageBudgetMinor)}
            currency={entitlements.currency}
            canEdit={isOwner}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>
            {paymentsConfigured
              ? "Paid monthly through Paystack. Cancel any time; your plan runs to the end of the paid month."
              : "Online payment isn't switched on yet (Paystack isn't configured), so plans can't be bought here. Contact Sunleon to be set up on a plan."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <p className="text-sm text-stone-600">No plans are available right now.</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {plans.map((plan) => (
                <li key={plan.id} className="space-y-2 rounded-md border border-stone-200 bg-white p-4">
                  <p className="font-medium text-stone-950">{plan.name}</p>
                  <p className="text-sm text-stone-700">{formatMoney(plan.priceMinor, plan.currency)} per month</p>
                  <p className="text-xs text-stone-500">
                    {plan.includedMinutes} minutes · {plan.maxConcurrentSessions} simultaneous · {plan.maxAgents} agents
                    {plan.overageRateMinorPerMinute
                      ? ` · overage ${formatMoney(plan.overageRateMinorPerMinute, plan.currency)}/min`
                      : " · no overage"}
                  </p>
                  {canManage && paymentsConfigured && plan.paystackPlanCode && !renewing ? (
                    <ChoosePlanButton
                      orgSlug={orgSlug}
                      planCode={plan.code}
                      label={subscription?.planId === plan.id ? `Renew ${plan.name}` : `Choose ${plan.name}`}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {renewing && canManage ? (
            <p className="mt-3 text-xs text-stone-500">To switch plans, cancel the current subscription first.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing history</CardTitle>
          <CardDescription>Paystack emails a receipt for each successful payment.</CardDescription>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-sm text-stone-600">No payments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-stone-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 text-stone-700">
                  {transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td className="py-2 pr-4">{formatDate(transaction.paidAt ?? transaction.createdAt)}</td>
                      <td className="py-2 pr-4">
                        {transaction.plan?.name ?? "—"}
                        {transaction.kind === "RENEWAL" ? " (renewal)" : ""}
                      </td>
                      <td className="py-2 pr-4">{formatMoney(transaction.amountMinor, transaction.currency)}</td>
                      <td className="py-2 pr-4">{transaction.status.toLowerCase()}</td>
                      <td className="py-2 font-mono text-xs">{transaction.reference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
