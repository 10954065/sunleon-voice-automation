-- Enable pgvector (available because docker-compose.yml uses the pgvector/pgvector:pg16 image).
CREATE EXTENSION IF NOT EXISTS vector;

-- Prisma's classic schema.prisma generator has no native vector column type, so this
-- column is managed entirely through raw SQL migrations and $queryRaw/$executeRaw in
-- application code. text-embedding-3-small (the model used by src/server/knowledge/embeddings.ts)
-- produces 1536-dimensional vectors.
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" vector(1536);

-- HNSW index for fast approximate cosine-distance search, scoped by the tenant/agent
-- columns already indexed via the @@index([organizationId, agentId]) in schema.prisma.
CREATE INDEX "KnowledgeChunk_embedding_cosine_idx" ON "KnowledgeChunk"
  USING hnsw ("embedding" vector_cosine_ops);