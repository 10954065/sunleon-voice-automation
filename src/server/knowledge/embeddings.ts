export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  embedMany(texts: string[]): Promise<number[][]>;
}

export class MissingEmbeddingCredentialsError extends Error {
  constructor() {
    super(
      "AI_GATEWAY_API_KEY is not set. Knowledge ingestion can validate, extract, and chunk " +
        "documents without it, but cannot generate real embeddings. See docs/PROVIDER_INTEGRATIONS.md."
    );
  }
}

/**
 * Routes through the Vercel AI Gateway using a plain "provider/model" string —
 * requires AI_GATEWAY_API_KEY. See docs/DECISIONS.md for why this provider/model
 * was chosen and docs/KNOWN_LIMITATIONS.md for the current credential gap.
 */
export class GatewayEmbeddingProvider implements EmbeddingProvider {
  async embedMany(texts: string[]): Promise<number[][]> {
    if (!process.env.AI_GATEWAY_API_KEY) {
      throw new MissingEmbeddingCredentialsError();
    }

    const { embedMany } = await import("ai");
    const { embeddings } = await embedMany({ model: EMBEDDING_MODEL, values: texts });
    return embeddings;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return new GatewayEmbeddingProvider();
}
