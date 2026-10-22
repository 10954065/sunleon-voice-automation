import "server-only";

import { prisma } from "@/server/db/client";

const MAX_SUMMARY_CHARS = 4000;

/**
 * Pulls a bounded slice of the tenant's ready knowledge chunks for the agent, to seed
 * session instructions at connect time (a lightweight RAG-via-system-prompt baseline
 * that works with zero live round trips). The search_knowledge tool (src/server/voice/tools.ts)
 * supplements this mid-conversation for anything not covered here. Always scoped by
 * organizationId AND agentId — never trust a caller-supplied id alone.
 */
export async function getKnowledgeSummary(params: {
  organizationId: string;
  agentId: string;
}): Promise<string | null> {
  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      organizationId: params.organizationId,
      agentId: params.agentId,
      source: { status: "READY" },
    },
    orderBy: { createdAt: "asc" },
    select: { content: true },
    take: 50,
  });

  if (chunks.length === 0) {
    return null;
  }

  let summary = "";
  for (const chunk of chunks) {
    if (summary.length + chunk.content.length + 1 > MAX_SUMMARY_CHARS) {
      break;
    }
    summary += `- ${chunk.content}\n`;
  }

  return summary.trim() || null;
}
