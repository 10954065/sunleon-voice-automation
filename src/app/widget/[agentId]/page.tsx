import type { Metadata } from "next";
import { headers } from "next/headers";

import { prisma } from "@/server/db/client";
import { extractHostname, isEmbedHostAllowed } from "@/server/voice/domains";
import { createEmbedTicket } from "@/server/voice/embedTicket";
import { VoiceWidget } from "@/components/voice-widget/voice-widget";

export const instant = false;

export const metadata: Metadata = {
  title: "Voice assistant",
  robots: { index: false, follow: false },
};

function NotAvailable() {
  return (
    <main className="p-4">
      <p className="text-sm text-stone-600">This voice assistant isn&apos;t available on this page.</p>
    </main>
  );
}

/**
 * Loaded inside an <iframe> on a business's site. The Referer of THIS request is set by the
 * visitor's browser from the embedding page and can't be forged by that page, so it is the
 * signal checked against the allowlist. Every failure renders the same message so the page
 * never reveals whether an agent exists or which check failed.
 */
export default async function WidgetPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const requestHeaders = await headers();
  const host = extractHostname(requestHeaders.get("referer"));

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, archivedAt: null },
    include: { organization: true, publishedVersion: true },
  });

  if (!agent || !agent.publishedVersion || !host || !isEmbedHostAllowed(host, agent.allowedEmbedDomains)) {
    return <NotAvailable />;
  }

  const ticket = createEmbedTicket({ agentId: agent.id, host });

  return (
    <main className="p-4">
      <VoiceWidget
        businessName={agent.organization.name}
        leadCaptureEnabled={agent.publishedVersion.leadCaptureEnabled}
        prepareUrl={`/api/voice/sessions/embed/${agent.id}`}
        prepareBody={{ ticket }}
        transcriptPolicy={
          agent.organization.storeTranscripts ? { retentionDays: agent.organization.transcriptRetentionDays } : null
        }
      />
    </main>
  );
}
