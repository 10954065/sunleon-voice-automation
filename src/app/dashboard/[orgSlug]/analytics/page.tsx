import Link from "next/link";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { getAnalyticsReport } from "@/server/analytics/report";
import { OUTCOME_LABELS } from "@/server/conversations/outcome";
import { analyticsFiltersSchema, firstValues, rangeForDays } from "@/lib/validation/history";
import { formatMinutes } from "@/lib/billing";
import { formatDate, formatDuration, formatPercent, queryString } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CHANNEL_OPTIONS, FilterSelect, RANGE_OPTIONS } from "@/components/dashboard/filter-select";

export const instant = false;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-stone-950">{value}</p>
      {note ? <p className="mt-1 text-xs text-stone-500">{note}</p> : null}
    </div>
  );
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  const filters = analyticsFiltersSchema.parse(firstValues(await searchParams));
  const range = rangeForDays(filters.days);

  const [report, agents] = await Promise.all([
    getAnalyticsReport({
      organizationId: context.organization.id,
      ...range,
      channel: filters.channel,
      agentId: filters.agent,
    }),
    prisma.agent.findMany({
      where: { organizationId: context.organization.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const { totals } = report;
  const peak = Math.max(1, ...report.daily.map((day) => day.sessions));
  const outcomeTotal = Math.max(1, report.outcomes.reduce((sum, row) => sum + row.count, 0));
  const historyLink = `/dashboard/${orgSlug}/conversations${queryString({ days: filters.days, channel: filters.channel, agent: filters.agent })}`;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Analytics</h1>
        <p className="mt-1 text-sm text-stone-500">
          Counted from recorded voice sessions and the usage ledger, {formatDate(range.from)} to today (UTC). Nothing
          here is estimated or sampled.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <FilterSelect name="days" label="Period" value={filters.days} options={RANGE_OPTIONS} />
        <FilterSelect name="channel" label="Channel" value={filters.channel} options={CHANNEL_OPTIONS} />
        <FilterSelect
          name="agent"
          label="Agent"
          value={filters.agent}
          options={[{ value: "", label: "All agents" }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]}
        />
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Sessions" value={String(totals.sessions)} note={`${totals.inProgress} in progress`} />
        <Stat label="Connected" value={String(totals.connected)} note="Reached the voice provider" />
        <Stat label="Voice time" value={formatMinutes(totals.voiceSeconds)} note="Billed seconds from the ledger" />
        <Stat
          label="Average length"
          value={totals.averageConnectedSeconds === null ? "—" : formatDuration(totals.averageConnectedSeconds)}
          note="Per connected session"
        />
        <Stat label="Leads captured" value={String(totals.leadConversations)} note="Sessions where a visitor left details" />
        <Stat label="Lead rate" value={formatPercent(totals.leadRate)} note="Of connected sessions" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sessions per day</CardTitle>
          <CardDescription>Darker bars are sessions that connected. Days are UTC.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {totals.sessions === 0 ? (
            <p className="text-sm text-stone-500">No sessions in this period.</p>
          ) : (
            <div className="flex h-40 items-end gap-px" role="img" aria-label={`${totals.sessions} sessions over ${report.daily.length} days`}>
              {report.daily.map((day) => (
                <div
                  key={day.day}
                  className="relative flex-1 rounded-t bg-amber-200"
                  style={{ height: `${(day.sessions / peak) * 100}%` }}
                  title={`${day.day}: ${day.sessions} sessions, ${day.connected} connected, ${formatMinutes(day.voiceSeconds)}`}
                >
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-t bg-amber-600"
                    style={{ height: day.sessions > 0 ? `${(day.connected / day.sessions) * 100}%` : 0 }}
                  />
                </div>
              ))}
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-stone-600">Show daily figures</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-stone-500">
                  <tr>
                    <th className="py-1 font-medium">Day</th>
                    <th className="py-1 font-medium">Sessions</th>
                    <th className="py-1 font-medium">Connected</th>
                    <th className="py-1 font-medium">Voice time</th>
                    <th className="py-1 font-medium">Leads</th>
                  </tr>
                </thead>
                <tbody>
                  {report.daily.map((day) => (
                    <tr key={day.day} className="border-t border-stone-100">
                      <td className="py-1">{day.day}</td>
                      <td className="py-1">{day.sessions}</td>
                      <td className="py-1">{day.connected}</td>
                      <td className="py-1">{formatMinutes(day.voiceSeconds)}</td>
                      <td className="py-1">{day.leadConversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outcomes</CardTitle>
            <CardDescription>Classified from what happened in each session, not guessed by a model.</CardDescription>
          </CardHeader>
          <CardContent>
            {report.outcomes.length === 0 ? (
              <p className="text-sm text-stone-500">No sessions in this period.</p>
            ) : (
              <ul className="space-y-2">
                {report.outcomes.map((row) => (
                  <li key={row.outcome} className="text-sm">
                    <div className="flex justify-between">
                      <Link
                        href={`/dashboard/${orgSlug}/conversations${queryString({ days: filters.days, outcome: row.outcome })}`}
                        className="text-stone-800 hover:underline"
                      >
                        {row.outcome === "IN_PROGRESS" ? "In progress" : OUTCOME_LABELS[row.outcome]}
                      </Link>
                      <span className="text-stone-600">{row.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-stone-100">
                      <div className="h-1.5 rounded bg-stone-500" style={{ width: `${(row.count / outcomeTotal) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By channel and agent</CardTitle>
            <CardDescription>
              Website {report.channels.EMBED} · Dashboard tests {report.channels.TEST}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {report.agents.length === 0 ? (
              <p className="text-sm text-stone-500">No sessions in this period.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-stone-500">
                  <tr>
                    <th className="py-1 font-medium">Agent</th>
                    <th className="py-1 font-medium">Sessions</th>
                    <th className="py-1 font-medium">Voice time</th>
                    <th className="py-1 font-medium">Leads</th>
                  </tr>
                </thead>
                <tbody>
                  {report.agents.map((row) => (
                    <tr key={row.agentId} className="border-t border-stone-100">
                      <td className="py-1.5">{row.name}</td>
                      <td className="py-1.5">{row.sessions}</td>
                      <td className="py-1.5">{formatMinutes(row.voiceSeconds)}</td>
                      <td className="py-1.5">{row.leadConversations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <Link href={historyLink} className="text-sm font-medium text-amber-700 hover:text-amber-800">
        See these sessions in the conversation history →
      </Link>
    </div>
  );
}
