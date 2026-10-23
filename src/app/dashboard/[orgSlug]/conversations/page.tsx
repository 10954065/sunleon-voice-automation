import Link from "next/link";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { listConversations } from "@/server/conversations/history";
import { OUTCOME_LABELS } from "@/server/conversations/outcome";
import { conversationFiltersSchema, firstValues, rangeForDays } from "@/lib/validation/history";
import { formatDateTime, formatDuration, queryString } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CHANNEL_OPTIONS, FilterSelect, RANGE_OPTIONS } from "@/components/dashboard/filter-select";

export const instant = false;

const OUTCOME_OPTIONS = [
  { value: "", label: "All outcomes" },
  ...Object.entries(OUTCOME_LABELS).map(([value, label]) => ({ value, label })),
  { value: "IN_PROGRESS", label: "In progress" },
];

export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  const filters = conversationFiltersSchema.parse(firstValues(await searchParams));

  const [page, agents] = await Promise.all([
    listConversations({
      organizationId: context.organization.id,
      ...rangeForDays(filters.days),
      agentId: filters.agent,
      channel: filters.channel,
      outcome: filters.outcome,
      cursor: filters.cursor,
    }),
    prisma.agent.findMany({
      where: { organizationId: context.organization.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const baseQuery = { days: filters.days, agent: filters.agent, channel: filters.channel, outcome: filters.outcome };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-950">Conversations</h1>
          <p className="mt-1 text-sm text-stone-500">Every voice session, newest first. Times are UTC.</p>
        </div>
        <a
          href={`/api/orgs/${orgSlug}/exports/conversations${queryString({ days: filters.days })}`}
          className="text-sm font-medium text-amber-700 hover:text-amber-800"
        >
          Export CSV ({filters.days} days)
        </a>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <FilterSelect name="days" label="Period" value={filters.days} options={RANGE_OPTIONS} />
        <FilterSelect name="channel" label="Channel" value={filters.channel} options={CHANNEL_OPTIONS} />
        <FilterSelect name="outcome" label="Outcome" value={filters.outcome} options={OUTCOME_OPTIONS} />
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

      <Card>
        <CardContent className="p-0">
          {page.rows.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No conversations match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-200 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Started</th>
                    <th className="px-4 py-2 font-medium">Agent</th>
                    <th className="px-4 py-2 font-medium">Channel</th>
                    <th className="px-4 py-2 font-medium">Outcome</th>
                    <th className="px-4 py-2 font-medium">Billed</th>
                    <th className="px-4 py-2 font-medium">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row) => (
                    <tr key={row.id} className="border-t border-stone-100 hover:bg-stone-50">
                      <td className="px-4 py-2">
                        <Link href={`/dashboard/${orgSlug}/conversations/${row.id}`} className="text-stone-900 hover:underline">
                          {formatDateTime(row.startedAt)}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-stone-700">{row.agentName}</td>
                      <td className="px-4 py-2 text-stone-700">
                        {row.channel === "TEST" ? "Dashboard test" : row.originDomain ?? "Website"}
                      </td>
                      <td className="px-4 py-2 text-stone-700">
                        {row.outcome ? OUTCOME_LABELS[row.outcome] : "In progress"}
                      </td>
                      <td className="px-4 py-2 text-stone-700">
                        {row.billedSeconds === null ? "—" : formatDuration(row.billedSeconds)}
                      </td>
                      <td className="px-4 py-2 text-xs text-stone-500">
                        {[
                          row.leadCount > 0 ? `${row.leadCount} lead${row.leadCount === 1 ? "" : "s"}` : null,
                          row.hasTranscript ? "transcript" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {filters.cursor ? (
          <Link href={`/dashboard/${orgSlug}/conversations${queryString(baseQuery)}`} className="text-stone-600 hover:underline">
            ← Newest
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link
            href={`/dashboard/${orgSlug}/conversations${queryString({ ...baseQuery, cursor: page.nextCursor })}`}
            className="font-medium text-amber-700 hover:text-amber-800"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
