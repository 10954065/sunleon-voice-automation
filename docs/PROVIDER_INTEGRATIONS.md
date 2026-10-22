# Provider Integrations — Sunleon Voice

## Status

**Phase 1 had zero external provider dependencies by design.** Phase 2 added an embeddings provider behind an adapter. Phase 3 adds real-time voice through the **same** provider (Vercel AI Gateway) and the same key. No live credential is configured in this environment, so both are implemented and tested up to the provider boundary, and the live calls are BLOCKED.

Everything below Phase 3 is still an **evaluation plan** for later phases, not a claim that those integrations exist or that pricing/capabilities have been verified against current provider documentation. Each will be re-verified against official docs immediately before it is implemented, per Part D: "Use official, current provider documentation... Never invent APIs or assume an account has access to a feature."

## Phase 2 — Knowledge ingestion & retrieval (implemented)

| Need | What's actually used | Notes |
|---|---|---|
| Document parsing | `pdf-parse` (PDF), `mammoth` (DOCX), `csv-parse` (CSV), native `Buffer` read (TXT/MD), `cheerio` (HTML → text for crawled pages) | Real, local, no API key required. Both `pdf-parse` and `mammoth` had breaking API changes versus older assumptions — verified against their actual installed type definitions before use, per `docs/DECISIONS.md`. |
| Website crawling | Node's built-in `fetch`, with hand-written SSRF protections (`src/server/knowledge/ssrf.ts`) | Blocks private/reserved/loopback/link-local IPs (including the 169.254.169.254 cloud metadata address), non-HTTP(S) schemes, non-standard ports, and validates every redirect hop, not just the initial URL. |
| Embeddings | Vercel AI Gateway via the `ai` SDK, plain model string `"openai/text-embedding-3-small"` (1536 dimensions) | **Requires `AI_GATEWAY_API_KEY`, not yet set in this environment.** Without it, `src/server/knowledge/embeddings.ts` throws `MissingEmbeddingCredentialsError` and the knowledge source is marked `FAILED` with that exact message — verified live in a real browser in this session rather than assumed. Get a key at vercel.com; no other code change needed. |
| Vector storage | pgvector extension, `pgvector/pgvector:pg16` Docker image locally | Production needs a managed Postgres provider that supports the `vector` extension (Neon and Vercel Postgres both do) — not yet provisioned. |
| File storage | Local disk (`src/server/knowledge/storage.ts`, `.uploads/`, gitignored) | Explicitly dev-only and documented as such. Must be swapped for an S3-compatible adapter (Vercel Blob / R2 / S3) before production — the `StorageAdapter` interface is already shaped for that swap. |

## Phase 3 — Real-time voice MVP (implemented; live session BLOCKED on credentials)

| Need | What's actually used | Notes |
|---|---|---|
| Speech ⇄ speech model | `openai/gpt-realtime-2` through the **Vercel AI Gateway realtime API** (`gateway.experimental_realtime` from `@ai-sdk/gateway` 4.0.116) | Same `AI_GATEWAY_API_KEY` as Phase 2 embeddings — no second provider account. Chosen over a direct OpenAI integration; see `docs/DECISIONS.md`. |
| Browser client | `experimental_useRealtime` from `@ai-sdk/react` 4.0.147 | Handles microphone capture (24 kHz PCM), playback, server VAD turn-taking, and barge-in (on `speech-started` it stops playback and sends `conversation-item-truncate` — read in the installed SDK source, not assumed). |
| Transport | Client-secret **WebSocket** (`ai-gateway-auth.<token>` subprotocol) | The brief allows "WebRTC when appropriate". The Gateway realtime model only supports client-secret WebSocket, so WebRTC isn't available on this path. |
| Session credential | Single-use Gateway client secret, 60-second expiry, minted server-side by `src/server/voice/provider.ts` | `AI_GATEWAY_API_KEY` never leaves the server. Our own token route also enforces single-use issuance per conversation within a 2-minute window. |
| Voices | OpenAI built-in realtime voices: marin, cedar (recommended), alloy, ash, ballad, coral, echo, sage, shimmer, verse | From OpenAI's realtime API reference (checked 2026-10-19). **Not yet heard through the Gateway** (no credentials), and **none evaluated for Ghanaian English** — Decision 3 of the brief. |
| Knowledge grounding | Bounded summary of READY knowledge in the session instructions, plus a `search_knowledge` realtime tool executed against our tenant-scoped pgvector retrieval | The tool needs embeddings, so the same `AI_GATEWAY_API_KEY`. |

What is verified vs. not, precisely:

- **Verified (tests and a real browser, without credentials):** consent → microphone permission → session preparation → error states; permission-denied message; the honest "Voice is not configured" blocker for dashboard users and the generic "temporarily unavailable" message for public visitors; embed authorization (allowed host shows the widget; a non-allowed host, a direct visit, and an unknown agent all show the same "not available" message); private instructions absent from the widget page HTML; single-use token issuance; tenant-isolated knowledge search; lead capture.
- **Not verified — BLOCKED on `AI_GATEWAY_API_KEY`:** an actual spoken conversation. That covers the Gateway accepting our session config, the voices sounding as named, tool calls arriving and being answered mid-call, interruption behaving well, and usage events (`session-usage`/`session-closed`) arriving. Every one of these must be checked in the first credentialed session; see `docs/PHASE_STATUS.md` for the checklist.

Important constraint found while building: the Gateway realtime model **ignores `sessionConfig` passed at mint time** (comment and code in `@ai-sdk/gateway`'s `GatewayRealtimeModel.doCreateClientSecret`). Instructions, voice and tools are applied by the browser's `session-update` event, so business instructions necessarily pass through the caller's browser. See `docs/SECURITY_MODEL.md` and `docs/DECISIONS.md`.

## Phase 4 — Billing

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Payments (Ghana-first) | Paystack | Named explicitly in the brief; must confirm current webhook signature scheme and supported payment methods for GHS before integrating |
| Payments (international, later) | Stripe | Only if/when international billing is prioritized |

## Phase 6 — Telephony

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Inbound/outbound calling | Twilio, Africa's Talking | Must verify actual Ghanaian number availability and pricing before advertising local calling — do not assume |

## Hosting / infrastructure (ongoing)

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Web hosting | Vercel | Preferred per spec; no project linked yet in this session |
| Managed Postgres | Neon or Vercel Postgres (via Vercel Marketplace) | Required before production deploy — not yet provisioned |
| Object storage | S3-compatible (Vercel Blob, Cloudflare R2, or AWS S3) | Needed starting Phase 2 for uploaded documents |
| Background jobs | TBD once a concrete async workload exists (ingestion, voice session cleanup) | Avoid adopting a job system before there's real async work to justify it (YAGNI) |

## Credentials needed from the developer, by phase

- **Phases 2 and 3 (now):** `AI_GATEWAY_API_KEY` — one key unblocks both real embeddings and real voice sessions. It must have access to `openai/gpt-realtime-2` on the Gateway (check the Gateway model list for your team). Allowed embed domains are configured per agent in Agent Studio, not via env vars.
- **Before production (any phase):** a managed Postgres provider with pgvector support, an S3-compatible object storage provider (to replace the local-disk adapter), and a linked Vercel project.
- **Phase 4:** Paystack account + API keys, webhook signing secret.
- **Phase 6:** telephony provider account + API keys, phone number provisioning.

None of these blocked Phase 1 or the non-embedding parts of Phase 2.
