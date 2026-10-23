import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";
import { listOrganizationsForAdmin } from "@/server/admin/overview";
import { firstValues } from "@/lib/validation/history";
import { formatMinutes } from "@/lib/billing";
import { formatDate, queryString } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { z } from "zod";

export const instant = false;

const cursorSchema = z.object({
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().catch(undefined),
});

export default async function AdminOrganizationsPage({
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
  const { cursor } = cursorSchema.parse(firstValues(await searchParams));
  const page = await listOrganizationsForAdmin({ cursor });

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Organizations</h1>
        <p className="mt-1 text-sm text-stone-500">
          Every workspace on the platform, newest first. Counts only: customers&apos; leads and transcripts are not shown
          here.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {page.rows.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No organizations yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-stone-200 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Organization</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Plan</th>
                    <th className="px-4 py-2 font-medium">Members</th>
                    <th className="px-4 py-2 font-medium">Agents</th>
                    <th className="px-4 py-2 font-medium">Sessions (30d)</th>
                    <th className="px-4 py-2 font-medium">Voice (30d)</th>
                    <th className="px-4 py-2 font-medium">Transcripts</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((org) => (
                    <tr key={org.id} className="border-t border-stone-100">
                      <td className="px-4 py-2">
                        <p className="text-stone-900">{org.name}</p>
                        <p className="font-mono text-xs text-stone-500">{org.slug}</p>
                      </td>
                      <td className="px-4 py-2 text-stone-700">{formatDate(org.createdAt)}</td>
                      <td className="px-4 py-2 text-stone-700">
                        {org.plan ? `${org.plan.name} · ${org.plan.status.toLowerCase().replace("_", " ")}` : "Trial / none"}
                      </td>
                      <td className="px-4 py-2 text-stone-700">{org.members}</td>
                      <td className="px-4 py-2 text-stone-700">{org.agents}</td>
                      <td className="px-4 py-2 text-stone-700">{org.conversations30d}</td>
                      <td className="px-4 py-2 text-stone-700">{formatMinutes(org.voiceSeconds30d)}</td>
                      <td className="px-4 py-2 text-stone-700">{org.storesTranscripts ? "On" : "Off"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {cursor ? (
          <Link href="/admin" className="text-stone-600 hover:underline">
            ← Newest
          </Link>
        ) : null}
        {page.nextCursor ? (
          <Link href={`/admin${queryString({ cursor: page.nextCursor })}`} className="font-medium text-amber-700 hover:text-amber-800">
            Older →
          </Link>
        ) : null}
      </div>
    </main>
  );
}
