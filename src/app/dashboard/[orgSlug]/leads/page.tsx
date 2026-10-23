import Link from "next/link";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { listLeads } from "@/server/leads/queries";
import { firstValues, leadFiltersSchema } from "@/lib/validation/history";
import { formatDateTime, queryString } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterSelect, RANGE_OPTIONS } from "@/components/dashboard/filter-select";
import { LeadControls } from "./lead-controls";

export const instant = false;

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "NEW", label: "New" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "CLOSED", label: "Closed" },
];

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  const filters = leadFiltersSchema.parse(firstValues(await searchParams));
  const isAdmin = context.role === "OWNER" || context.role === "ADMIN";

  const [page, agents] = await Promise.all([
    listLeads({
      organizationId: context.organization.id,
      status: filters.status,
      agentId: filters.agent,
      cursor: filters.cursor,
    }),
    prisma.agent.findMany({
      where: { organizationId: context.organization.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const baseQuery = { status: filters.status, agent: filters.agent };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-950">Leads</h1>
          <p className="mt-1 text-sm text-stone-500">
            Contact details visitors chose to share. Kept for {context.organization.leadRetentionDays} days, then deleted
            automatically.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap gap-3 text-sm">
            {RANGE_OPTIONS.filter((option) => option.value !== 7).map((option) => (
              <a
                key={option.value}
                href={`/api/orgs/${orgSlug}/exports/leads${queryString({ days: option.value })}`}
                className="font-medium text-amber-700 hover:text-amber-800"
              >
                Export {option.value} days
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <FilterSelect name="status" label="Status" value={filters.status} options={STATUS_OPTIONS} />
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
            <p className="p-6 text-sm text-stone-500">No leads match these filters.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {page.rows.map((lead) => (
                <li key={lead.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium text-stone-900">{lead.name || "Unnamed visitor"}</p>
                    <p className="text-stone-700">{[lead.phone, lead.email].filter(Boolean).join(" · ") || "—"}</p>
                    {lead.note ? <p className="whitespace-pre-line text-stone-600">{lead.note}</p> : null}
                    <p className="text-xs text-stone-500">
                      {formatDateTime(lead.createdAt)} · {lead.agent.name}
                      {lead.conversationId ? (
                        <>
                          {" · "}
                          <Link href={`/dashboard/${orgSlug}/conversations/${lead.conversationId}`} className="hover:underline">
                            conversation
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <LeadControls
                    orgSlug={orgSlug}
                    leadId={lead.id}
                    status={lead.status}
                    canEditStatus={context.role !== "ANALYST"}
                    canDelete={isAdmin}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {filters.cursor ? (
          <Link href={`/dashboard/${orgSlug}/leads${queryString(baseQuery)}`} className="text-stone-600 hover:underline">
            ← Newest
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link
            href={`/dashboard/${orgSlug}/leads${queryString({ ...baseQuery, cursor: page.nextCursor })}`}
            className="font-medium text-amber-700 hover:text-amber-800"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
