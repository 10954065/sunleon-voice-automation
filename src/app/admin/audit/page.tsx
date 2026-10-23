import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";
import { listAuditLogs } from "@/server/audit/queries";
import { auditFiltersSchema, firstValues } from "@/lib/validation/history";
import { queryString } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterSelect } from "@/components/dashboard/filter-select";
import { AUDIT_ACTION_OPTIONS, AuditTable } from "@/components/dashboard/audit-table";

export const instant = false;

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }
  const filters = auditFiltersSchema.parse(firstValues(await searchParams));
  const page = await listAuditLogs({ organizationId: null, actionPrefix: filters.action, cursor: filters.cursor });

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Audit log</h1>
        <p className="mt-1 text-sm text-stone-500">Every organization&apos;s entries plus platform-level actions, newest first.</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <FilterSelect name="action" label="Action" value={filters.action} options={AUDIT_ACTION_OPTIONS} />
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>

      <Card>
        <CardContent className="p-0">
          <AuditTable rows={page.rows} showOrganization />
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {filters.cursor ? (
          <Link href={`/admin/audit${queryString({ action: filters.action })}`} className="text-stone-600 hover:underline">
            ← Newest
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link
            href={`/admin/audit${queryString({ action: filters.action, cursor: page.nextCursor })}`}
            className="font-medium text-amber-700 hover:text-amber-800"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </main>
  );
}
