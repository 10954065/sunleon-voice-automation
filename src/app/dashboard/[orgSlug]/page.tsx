import Link from "next/link";

import { prisma } from "@/server/db/client";
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

  const agentCount = await prisma.agent.count({
    where: { organizationId: context.organization.id, archivedAt: null },
  });

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
          <CardTitle>{agentCount === 0 ? "No agents yet" : `${agentCount} agent${agentCount === 1 ? "" : "s"}`}</CardTitle>
          <CardDescription>
            Configure each agent&apos;s instructions, knowledge and voice, test it in your browser, then
            embed it on your website.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/dashboard/${orgSlug}/agents`} className="text-sm font-medium text-amber-700 hover:text-amber-800">
            {agentCount === 0 ? "Create your first agent →" : "Manage agents →"}
          </Link>
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
