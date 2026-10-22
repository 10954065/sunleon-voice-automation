import { notFound } from "next/navigation";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AgentDraftForm } from "./agent-draft-form";
import { PublishControls } from "./publish-controls";
import { KnowledgeSourcesList } from "./knowledge-sources-list";
import { AddKnowledgeSourceForms } from "./add-knowledge-source-forms";
import { EmbedSettings } from "./embed-settings";
import { VoiceActivity } from "./voice-activity";
import { VoiceWidget } from "@/components/voice-widget/voice-widget";

export const instant = false;

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; agentId: string }>;
}) {
  const { orgSlug, agentId } = await params;
  const context = await requireOrgContext(orgSlug);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: context.organization.id },
    include: {
      versions: { orderBy: { versionNumber: "desc" } },
      publishedVersion: true,
      knowledgeSources: { orderBy: { createdAt: "desc" } },
      conversations: { orderBy: { startedAt: "desc" }, take: 10 },
      leads: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!agent) {
    notFound();
  }

  const draft = agent.versions.find((v) => !v.publishedAt) ?? null;
  const publishedVersions = agent.versions.filter((v) => v.publishedAt);
  const canManage = context.role !== "ANALYST";
  const canRollback = context.role === "OWNER" || context.role === "ADMIN";
  const latestVersion = agent.versions[0] ?? null;
  const appUrl = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">{agent.name}</h1>
        <p className="mt-1 text-sm text-stone-500">
          {agent.publishedVersion
            ? `Published as version ${agent.publishedVersion.versionNumber}.`
            : "Not published yet — only visible in this dashboard."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Instructions (draft)</CardTitle>
          <CardDescription>
            Changes here only take effect for new conversations after you publish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgentDraftForm
            orgSlug={orgSlug}
            agentId={agent.id}
            draft={draft ?? agent.publishedVersion}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>

      {canManage ? (
        <PublishControls
          orgSlug={orgSlug}
          agentId={agent.id}
          hasDraft={Boolean(draft)}
          currentPublishedVersionId={agent.publishedVersionId}
          publishedVersions={publishedVersions.map((v) => ({
            id: v.id,
            versionNumber: v.versionNumber,
            publishedAt: v.publishedAt!.toISOString(),
          }))}
          canRollback={canRollback}
        />
      ) : null}

      <div>
        <h2 className="text-lg font-semibold text-stone-950">Knowledge</h2>
        <p className="mt-1 text-sm text-stone-500">
          FAQs, documents, and website pages this agent can ground its answers in.
        </p>
      </div>

      <KnowledgeSourcesList
        orgSlug={orgSlug}
        sources={agent.knowledgeSources.map((s) => ({
          id: s.id,
          type: s.type,
          title: s.title,
          status: s.status,
          errorMessage: s.errorMessage,
        }))}
        canManage={canManage}
      />

      {canManage ? (
        <AddKnowledgeSourceForms orgSlug={orgSlug} agentId={agent.id} />
      ) : null}

      <div>
        <h2 className="text-lg font-semibold text-stone-950">Voice</h2>
        <p className="mt-1 text-sm text-stone-500">
          Talk to this agent in your browser, then embed it on your website.
        </p>
      </div>

      {canManage && latestVersion ? (
        <Card>
          <CardHeader>
            <CardTitle>Test voice</CardTitle>
            <CardDescription>
              Uses your latest version{draft ? " (the unpublished draft)" : ""}. Test calls are logged as sessions but
              are never shown to website visitors.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VoiceWidget
              businessName={context.organization.name}
              leadCaptureEnabled={latestVersion.leadCaptureEnabled}
              prepareUrl={`/api/voice/sessions/test/${agent.id}?org=${encodeURIComponent(orgSlug)}`}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Embed on your website</CardTitle>
          <CardDescription>Visitors talk to the published version only.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmbedSettings
            orgSlug={orgSlug}
            agentId={agent.id}
            businessName={context.organization.name}
            appUrl={appUrl}
            allowedDomains={agent.allowedEmbedDomains}
            isPublished={Boolean(agent.publishedVersion)}
            canEditDomains={canRollback}
          />
        </CardContent>
      </Card>

      <VoiceActivity
        conversations={agent.conversations.map((c) => ({
          id: c.id,
          channel: c.channel,
          status: c.status,
          originDomain: c.originDomain,
          startedAt: c.startedAt.toISOString(),
          endedAt: c.endedAt?.toISOString() ?? null,
          closeReason: c.closeReason,
          errorMessage: c.errorMessage,
        }))}
        leads={agent.leads.map((l) => ({
          id: l.id,
          name: l.name,
          phone: l.phone,
          email: l.email,
          note: l.note,
          createdAt: l.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
