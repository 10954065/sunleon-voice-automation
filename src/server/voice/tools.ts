import "server-only";

import type { Experimental_RealtimeToolDefinition as RealtimeToolDefinition } from "ai";

/**
 * Lets the realtime model pull fresh knowledge mid-conversation instead of relying only
 * on the static summary baked into session instructions at connect time. The widget's
 * onToolCall handler executes this against the tenant-scoped retrieval pipeline — see
 * src/app/api/voice/tools/search-knowledge/route.ts.
 */
export const SEARCH_KNOWLEDGE_TOOL: RealtimeToolDefinition = {
  type: "function",
  name: "search_knowledge",
  description:
    "Search this business's knowledge base for facts to answer the caller's question. " +
    "Always call this before answering any factual question about the business (hours, " +
    "prices, services, location, policies). Never invent an answer instead of calling it.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The caller's question or topic to search for, in their own words.",
      },
    },
    required: ["query"],
  },
};
