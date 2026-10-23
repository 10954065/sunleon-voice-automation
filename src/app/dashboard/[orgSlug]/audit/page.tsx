import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgContext } from "@/server/auth/session";
import { listAuditLogs } from "@/server/audit/queries";
import { auditFiltersSchema, firstValues } from "@/lib/validation/history";
import { queryString } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterSelect } from "@/components/dashboard/filter-select";
import { AUDIT_ACTION_OPTIONS, AuditTable } from "@/components/dashboard/audit-table";

export const instant = false;

export default async function AuditLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  if (context.role !== "OWNER" && context.role !== "ADMIN") {
    notFound();
  }
  const filters = auditFiltersSchema.parse(firstValues(await searchParams));
  const page = await listAuditLogs({
    organizationId: context.organization.id,
    actionPrefix: filters.action,
    cursor: filters.cursor,
  });

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Audit log</h1>
        <p className="mt-1 text-sm text-stone-500">
          Who changed what in this workspace, including automatic retention deletions. Entries can&apos;t be edited or
          deleted from the app.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <FilterSelect name="action" label="Action" value={filters.action} options={AUDIT_ACTION_OPTIONS} />
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>

      <Card>
        <CardContent className="p-0">
          <AuditTable rows={page.rows} showOrganization={false} />
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {filters.cursor ? (
          <Link href={`/dashboard/${orgSlug}/audit${queryString({ action: filters.action })}`} className="text-stone-600 hover:underline">
            ← Newest
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link
            href={`/dashboard/${orgSlug}/audit${queryString({ action: filters.action, cursor: page.nextCursor })}`}
            className="font-medium text-amber-700 hover:text-amber-800"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
