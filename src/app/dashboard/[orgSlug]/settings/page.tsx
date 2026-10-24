import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataSettingsForm, DeleteAllTranscriptsForm, EraseContactForm } from "./data-settings-forms";

export const instant = false;

export default async function DataSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  const { organization, role } = context;
  const isOwner = role === "OWNER";
  const isAdmin = isOwner || role === "ADMIN";
  const transcriptCount = await prisma.conversationTranscript.count({ where: { organizationId: organization.id } });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Data &amp; privacy</h1>
        <p className="mt-1 text-sm text-stone-500">What this workspace keeps about the people who talk to your agents.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What is stored</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">
            <li>Audio is never recorded or stored.</li>
            <li>
              Session records (time, length, website, outcome) are kept for history and billing. They contain no contact
              details or transcript text.
            </li>
            <li>Leads: only what a visitor typed into the contact form, kept for the period below.</li>
            <li>
              Phone calls: the caller&apos;s number is kept with the call record for the lead period below, then removed.
              Call audio is not recorded. The do-not-call list is kept until the owner removes an entry.
            </li>
            <li>
              Transcripts: only when turned on below <em>and</em> the visitor ticks the box before their call, kept for the
              period below. {transcriptCount} stored now.
            </li>
            <li>A daily clean-up deletes transcripts and leads older than their period, and records it in the audit log.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcripts and retention</CardTitle>
          <CardDescription>
            Turning transcripts off stops new ones; transcripts already stored stay until their period ends or you delete
            them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataSettingsForm
            orgSlug={orgSlug}
            storeTranscripts={organization.storeTranscripts}
            transcriptRetentionDays={organization.transcriptRetentionDays}
            leadRetentionDays={organization.leadRetentionDays}
            canEdit={isOwner}
          />
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Erase a person&apos;s data</CardTitle>
            <CardDescription>
              For a visitor who asks to be deleted. Removes their leads (matched by email or phone, however the number was
              typed) and the transcripts of those conversations or any transcript mentioning their email. The audit log
              records only the counts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EraseContactForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      ) : null}

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Delete all transcripts</CardTitle>
            <CardDescription>Permanently removes every stored transcript and summary in this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteAllTranscriptsForm orgSlug={orgSlug} count={transcriptCount} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
