import { requireOrgContext } from "@/server/auth/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const instant = false;

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Overview</h1>
        <p className="mt-1 text-sm text-stone-500">
          Welcome, {context.user.name ?? context.user.email}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>No agents yet</CardTitle>
          <CardDescription>
            Agent creation, knowledge upload, and voice conversations ship in Phase 2 and Phase 3
            of this build. There is nothing fake to show here in the meantime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-stone-500">
            Once Agent Studio lands, you&apos;ll configure your first agent from this page.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>No usage yet</CardTitle>
          <CardDescription>
            Usage metering and billing land in Phase 4. No estimated costs are shown here until
            real conversations exist to measure.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
