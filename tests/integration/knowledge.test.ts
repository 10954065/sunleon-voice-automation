import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { processKnowledgeSource } from "@/server/knowledge/pipeline";
import { retrieveRelevantChunks } from "@/server/knowledge/retrieval";
import type { EmbeddingProvider } from "@/server/knowledge/embeddings";
import { EMBEDDING_DIMENSIONS } from "@/server/knowledge/embeddings";
import { resetDatabase } from "./helpers";

/** Deterministic fake — same text always maps to the same vector, distinct texts differ
 * enough for ORDER BY distance to behave sensibly. Never used outside tests. */
const fakeEmbeddingProvider: EmbeddingProvider = {
  async embedMany(texts: string[]) {
    return texts.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
      for (let i = 0; i < text.length; i += 1) {
        vector[i % EMBEDDING_DIMENSIONS] += text.charCodeAt(i) / 255;
      }
      return vector;
    });
  },
};

async function createOrgAgent() {
  const organization = await prisma.organization.create({ data: { name: "Org", slug: "org" } });
  const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: "Agent" } });
  return { organization, agent };
}

describe("processKnowledgeSource", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("chunks and embeds a MANUAL source, marking it READY", async () => {
    const { organization, agent } = await createOrgAgent();
    const source = await prisma.knowledgeSource.create({
      data: {
        organizationId: organization.id,
        agentId: agent.id,
        type: "MANUAL",
        title: "Business hours",
        rawContent: "We are open Monday to Saturday, 9am to 6pm. Closed on Sundays.",
      },
    });

    await processKnowledgeSource(source.id, organization.id, fakeEmbeddingProvider);

    const updated = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(updated.status).toBe("READY");

    const chunks = await prisma.knowledgeChunk.findMany({ where: { sourceId: source.id } });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("marks a source FAILED with an error message when extraction yields no text", async () => {
    const { organization, agent } = await createOrgAgent();
    const source = await prisma.knowledgeSource.create({
      data: {
        organizationId: organization.id,
        agentId: agent.id,
        type: "MANUAL",
        title: "Empty",
        rawContent: "   ",
      },
    });

    await expect(
      processKnowledgeSource(source.id, organization.id, fakeEmbeddingProvider)
    ).rejects.toThrow();

    const updated = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorMessage).toBeTruthy();
  });

  it("refuses to process a source id that does not belong to the given organization", async () => {
    const { organization: orgA, agent: agentA } = await createOrgAgent();
    const source = await prisma.knowledgeSource.create({
      data: {
        organizationId: orgA.id,
        agentId: agentA.id,
        type: "MANUAL",
        title: "Org A data",
        rawContent: "Confidential Org A business details.",
      },
    });

    const orgB = await prisma.organization.create({ data: { name: "Org B", slug: "org-b" } });

    await expect(
      processKnowledgeSource(source.id, orgB.id, fakeEmbeddingProvider)
    ).rejects.toThrow();
  });
});

describe("retrieveRelevantChunks", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("only returns chunks scoped to the given organization and agent", async () => {
    const { organization: orgA, agent: agentA } = await createOrgAgent();
    const orgB = await prisma.organization.create({ data: { name: "Org B", slug: "org-b" } });
    const agentB = await prisma.agent.create({ data: { organizationId: orgB.id, name: "Agent B" } });

    const sourceA = await prisma.knowledgeSource.create({
      data: { organizationId: orgA.id, agentId: agentA.id, type: "MANUAL", title: "A", rawContent: "Org A secret pricing details." },
    });
    const sourceB = await prisma.knowledgeSource.create({
      data: { organizationId: orgB.id, agentId: agentB.id, type: "MANUAL", title: "B", rawContent: "Org B secret pricing details." },
    });

    await processKnowledgeSource(sourceA.id, orgA.id, fakeEmbeddingProvider);
    await processKnowledgeSource(sourceB.id, orgB.id, fakeEmbeddingProvider);

    const [{ embeddings }] = [{ embeddings: await fakeEmbeddingProvider.embedMany(["pricing"]) }];

    const results = await retrieveRelevantChunks({
      organizationId: orgA.id,
      agentId: agentA.id,
      queryEmbedding: embeddings[0],
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      const chunk = await prisma.knowledgeChunk.findUniqueOrThrow({ where: { id: result.id } });
      expect(chunk.organizationId).toBe(orgA.id);
    }
  });
});
