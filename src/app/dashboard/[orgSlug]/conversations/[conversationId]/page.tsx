import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgContext } from "@/server/auth/session";
import { getConversationDetail } from "@/server/conversations/history";
import { OUTCOME_LABELS } from "@/server/conversations/outcome";
import { readTranscriptEntries, transcriptExpiresAt } from "@/server/conversations/transcripts";
import { isSummaryConfigured } from "@/server/conversations/summaries";
import { conversationIdSchema } from "@/lib/validation/voice";
import { formatDate, formatDateTime, formatDuration } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteTranscriptButton, GenerateSummaryButton } from "./conversation-controls";

export const instant = false;

const EVENT_LABELS: Record<string, string> = {
  SESSION_STARTED: "Connected to the voice provider",
  SESSION_ENDED: "Session ended",
  TOOL_CALL: "Tool used",
  ERROR: "Error",
};

function describeEvent(type: string, metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const data = metadata as Record<string, unknown>;
  if (type === "TOOL_CALL") {
    return data.tool === "capture_lead" ? "Visitor left contact details" : `Knowledge search (${String(data.resultCount ?? 0)} results)`;
  }
  if (type === "SESSION_ENDED") {
    const reason = typeof data.reason === "string" ? data.reason.replace(/_/g, " ") : "ended";
    return `${reason} · billed ${formatDuration(Number(data.chargedSeconds ?? 0))}`;
  }
  if (type === "ERROR") {
    return typeof data.stage === "string" ? `Failed at ${data.stage.replace(/_/g, " ")}` : null;
  }
  return null;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-sm text-stone-900">{children}</dd>
    </div>
  );
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; conversationId: string }>;
}) {
  const { orgSlug, conversationId } = await params;
  const context = await requireOrgContext(orgSlug);
  const id = conversationIdSchema.safeParse(conversationId);
  const detail = id.success ? await getConversationDetail(context.organization.id, id.data) : null;
  if (!detail) {
    notFound();
  }

  const { conversation, ledgerEntry } = detail;
  const transcript = conversation.transcript;
  const entries = transcript ? readTranscriptEntries(transcript.entries) : [];
  const canDelete = context.role === "OWNER" || context.role === "ADMIN";
  const canSummarize = context.role !== "ANALYST";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href={`/dashboard/${orgSlug}/conversations`} className="text-sm text-stone-500 hover:text-stone-700">
          ← Conversations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-stone-950">Conversation</h1>
        <p className="mt-1 text-sm text-stone-500">{formatDateTime(conversation.startedAt)}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Detail label="Agent">
              <Link href={`/dashboard/${orgSlug}/agents/${conversation.agent.id}`} className="hover:underline">
                {conversation.agent.name}
              </Link>{" "}
              (v{conversation.agentVersion.versionNumber})
            </Detail>
            <Detail label="Channel">
              {conversation.channel === "TEST" ? "Dashboard test" : `Website · ${conversation.originDomain ?? "unknown"}`}
            </Detail>
            <Detail label="Outcome">{conversation.outcome ? OUTCOME_LABELS[conversation.outcome] : "In progress"}</Detail>
            <Detail label="Billed time">
              {ledgerEntry
                ? `${formatDuration(ledgerEntry.quantity)}${ledgerEntry.source === "sweeper_reservation" ? " (full reservation — end not reported)" : ""}`
                : "Not billed"}
            </Detail>
            <Detail label="Ended">{conversation.endedAt ? formatDateTime(conversation.endedAt) : "—"}</Detail>
            <Detail label="Close reason">{conversation.closeReason?.replace(/_/g, " ") ?? "—"}</Detail>
          </dl>
          {conversation.errorMessage ? <p className="mt-4 text-sm text-red-700">{conversation.errorMessage}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
          <CardDescription>
            {transcript
              ? `Reported by the caller's browser when the call ended — not verified against the voice provider. Deleted automatically on ${formatDate(
                  transcriptExpiresAt(transcript.createdAt, context.organization.transcriptRetentionDays)
                )} (${context.organization.transcriptRetentionDays}-day retention).`
              : conversation.transcriptConsent
                ? "The visitor agreed to a transcript, but none is stored: it didn't arrive, or it was deleted."
                : "No transcript: transcript storage was off, or the visitor didn't agree to it."}
          </CardDescription>
        </CardHeader>
        {transcript ? (
          <CardContent className="space-y-4">
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Summary</p>
              {transcript.summary ? (
                <>
                  <p className="mt-1 whitespace-pre-line text-sm text-stone-800">{transcript.summary}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    AI-generated by {transcript.summaryModel} — may be inaccurate; check the transcript.
                  </p>
                </>
              ) : !isSummaryConfigured() ? (
                <p className="mt-1 text-sm text-stone-600">
                  Summaries aren&apos;t available yet: the AI provider key (AI_GATEWAY_API_KEY) isn&apos;t configured.
                </p>
              ) : canSummarize ? (
                <div className="mt-2">
                  <GenerateSummaryButton orgSlug={orgSlug} conversationId={conversation.id} label="Summarise this conversation" />
                </div>
              ) : (
                <p className="mt-1 text-sm text-stone-600">No summary yet.</p>
              )}
            </div>
            <ol aria-label="Transcript" className="space-y-2 text-sm">
              {entries.map((entry, index) => (
                <li key={index}>
                  <span className="font-medium text-stone-900">{entry.role === "user" ? "Caller" : "Agent"}: </span>
                  <span className="whitespace-pre-line text-stone-700">{entry.text}</span>
                </li>
              ))}
            </ol>
            {entries.every((entry) => entry.role === "assistant") ? (
              <p className="text-xs text-stone-500">Only the agent&apos;s speech is transcribed at the moment.</p>
            ) : null}
            {canDelete ? <DeleteTranscriptButton orgSlug={orgSlug} conversationId={conversation.id} /> : null}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leads</CardTitle>
        </CardHeader>
        <CardContent>
          {conversation.leads.length === 0 ? (
            <p className="text-sm text-stone-500">No contact details were left in this conversation.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {conversation.leads.map((lead) => (
                <li key={lead.id}>
                  <p className="font-medium text-stone-900">{lead.name || "Unnamed visitor"}</p>
                  <p className="text-stone-700">{[lead.phone, lead.email].filter(Boolean).join(" · ") || "—"}</p>
                  {lead.note ? <p className="text-stone-600">{lead.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Recorded server-side as the session progressed.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            <li className="text-stone-700">
              <span className="text-stone-500">{formatDateTime(conversation.startedAt)} · </span>Session prepared
            </li>
            {conversation.usageEvents.map((event) => {
              const description = describeEvent(event.type, event.metadata);
              return (
                <li key={event.id} className={event.type === "ERROR" ? "text-red-700" : "text-stone-700"}>
                  <span className="text-stone-500">{formatDateTime(event.createdAt)} · </span>
                  {EVENT_LABELS[event.type] ?? event.type}
                  {description ? ` — ${description}` : ""}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
