import "server-only";

import { prisma } from "@/server/db/client";
import { chunkText } from "@/server/knowledge/chunk";
import { extractTextFromFile, extractTextFromHtml } from "@/server/knowledge/extract";
import { fetchUrlSafely } from "@/server/knowledge/ssrf";
import { getStorageAdapter } from "@/server/knowledge/storage";
import { getEmbeddingProvider, type EmbeddingProvider } from "@/server/knowledge/embeddings";
import { storeChunkEmbedding } from "@/server/knowledge/retrieval";

async function resolveSourceText(source: {
  type: string;
  rawContent: string | null;
  sourceUrl: string | null;
  storageKey: string | null;
}): Promise<string> {
  switch (source.type) {
    case "FAQ":
    case "MANUAL":
      return source.rawContent ?? "";
    case "URL": {
      if (!source.sourceUrl) throw new Error("URL source is missing sourceUrl");
      const { html } = await fetchUrlSafely(source.sourceUrl);
      return extractTextFromHtml(html);
    }
    case "FILE": {
      if (!source.storageKey) throw new Error("FILE source is missing storageKey");
      const extension = source.storageKey.split(".").pop() ?? "";
      const buffer = await getStorageAdapter().get(source.storageKey);
      return extractTextFromFile(buffer, extension);
    }
    default:
      throw new Error(`Unknown knowledge source type: ${source.type}`);
  }
}

/**
 * Runs synchronously within the calling request for Phase 2 — small enough volume that a
 * background job queue isn't justified yet (YAGNI). Revisit once upload sizes/volume grow.
 * organizationId is passed by the caller from a server-resolved tenant context and used to
 * scope every read/write, so this can never touch another tenant's source by id alone.
 */
export async function processKnowledgeSource(
  sourceId: string,
  organizationId: string,
  embeddingProvider: EmbeddingProvider = getEmbeddingProvider()
): Promise<void> {
  const source = await prisma.knowledgeSource.findFirstOrThrow({
    where: { id: sourceId, organizationId },
  });

  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { status: "PROCESSING", errorMessage: null },
  });

  try {
    const text = await resolveSourceText(source);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No extractable text was found in this source");
    }

    await prisma.knowledgeChunk.deleteMany({ where: { sourceId: source.id } });

    const createdChunks = await prisma.$transaction(
      chunks.map((content, chunkIndex) =>
        prisma.knowledgeChunk.create({
          data: {
            sourceId: source.id,
            organizationId: source.organizationId,
            agentId: source.agentId,
            chunkIndex,
            content,
          },
        })
      )
    );

    const embeddings = await embeddingProvider.embedMany(chunks);

    for (let i = 0; i < createdChunks.length; i += 1) {
      await storeChunkEmbedding({
        chunkId: createdChunks[i].id,
        organizationId: source.organizationId,
        embedding: embeddings[i],
      });
    }

    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "READY" },
    });
  } catch (error) {
    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown processing error",
      },
    });
    throw error;
  }
}
