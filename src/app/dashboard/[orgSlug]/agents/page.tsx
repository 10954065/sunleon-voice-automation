import Link from "next/link";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CreateAgentForm } from "./create-agent-form";

export const instant = false;

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);

  const agents = await prisma.agent.findMany({
    where: { organizationId: context.organization.id, archivedAt: null },
    include: { publishedVersion: true },
    orderBy: { createdAt: "asc" },
  });

  const canManageAgents = context.role !== "ANALYST";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Agents</h1>
        <p className="mt-1 text-sm text-stone-500">
          Configure instructions, knowledge and voice for each agent, test it by voice, and embed it on
          your website.
        </p>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No agents yet</CardTitle>
            <CardDescription>Create your first agent to start configuring it.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-stone-100 p-0">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/dashboard/${orgSlug}/agents/${agent.id}`}
                className="flex items-center justify-between px-6 py-4 hover:bg-stone-50"
              >
                <span className="text-sm font-medium text-stone-950">{agent.name}</span>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    agent.publishedVersion
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-stone-100 text-stone-600"
                  }`}
                >
                  {agent.publishedVersion ? "Published" : "Draft only"}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {canManageAgents ? (
        <Card>
          <CardHeader>
            <CardTitle>Create an agent</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateAgentForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
