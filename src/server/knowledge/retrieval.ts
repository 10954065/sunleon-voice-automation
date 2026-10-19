import "server-only";

import { prisma } from "@/server/db/client";

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  content: string;
  distance: number;
}

/**
 * Tenant-scoped similarity search. organizationId and agentId are always supplied by
 * the caller from a server-resolved tenant context (see src/server/auth/session.ts) —
 * never from unvalidated client input. Both are included in the WHERE clause so a query
 * can never cross a tenant or agent boundary, mirroring the Phase 1 tenant-isolation rule.
 */
export async function retrieveRelevantChunks(params: {
  organizationId: string;
  agentId: string;
  queryEmbedding: number[];
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const limit = params.limit ?? 5;
  const vectorLiteral = `[${params.queryEmbedding.join(",")}]`;

  return prisma.$queryRaw<RetrievedChunk[]>`
    SELECT "id", "sourceId", "content",
           ("embedding" <=> ${vectorLiteral}::vector) AS "distance"
    FROM "KnowledgeChunk"
    WHERE "organizationId" = ${params.organizationId}
      AND "agentId" = ${params.agentId}
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;
}

export async function storeChunkEmbedding(params: {
  chunkId: string;
  organizationId: string;
  embedding: number[];
}): Promise<void> {
  const vectorLiteral = `[${params.embedding.join(",")}]`;
  // organizationId is included even though id is already unique, as a defense-in-depth
  // guard against ever updating a row outside the caller's tenant.
  await prisma.$executeRaw`
    UPDATE "KnowledgeChunk"
    SET "embedding" = ${vectorLiteral}::vector
    WHERE "id" = ${params.chunkId} AND "organizationId" = ${params.organizationId}
  `;
}
