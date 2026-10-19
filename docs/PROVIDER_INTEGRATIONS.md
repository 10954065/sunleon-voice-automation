# Provider Integrations — Sunleon Voice

## Status

**Phase 1 had zero external provider dependencies by design.** Phase 2 adds exactly one: an embeddings provider, behind an adapter, with no live credential configured in this environment — document extraction, chunking, and SSRF-protected crawling are all real, local, credential-free functionality; only the embedding step needs a key.

Everything below Phase 2 is still an **evaluation plan** for later phases, not a claim that those integrations exist or that pricing/capabilities have been verified against current provider documentation. Each will be re-verified against official docs immediately before it is implemented, per Part D: "Use official, current provider documentation... Never invent APIs or assume an account has access to a feature."

## Phase 2 — Knowledge ingestion & retrieval (implemented)

| Need | What's actually used | Notes |
|---|---|---|
| Document parsing | `pdf-parse` (PDF), `mammoth` (DOCX), `csv-parse` (CSV), native `Buffer` read (TXT/MD), `cheerio` (HTML → text for crawled pages) | Real, local, no API key required. Both `pdf-parse` and `mammoth` had breaking API changes versus older assumptions — verified against their actual installed type definitions before use, per `docs/DECISIONS.md`. |
| Website crawling | Node's built-in `fetch`, with hand-written SSRF protections (`src/server/knowledge/ssrf.ts`) | Blocks private/reserved/loopback/link-local IPs (including the 169.254.169.254 cloud metadata address), non-HTTP(S) schemes, non-standard ports, and validates every redirect hop, not just the initial URL. |
| Embeddings | Vercel AI Gateway via the `ai` SDK, plain model string `"openai/text-embedding-3-small"` (1536 dimensions) | **Requires `AI_GATEWAY_API_KEY`, not yet set in this environment.** Without it, `src/server/knowledge/embeddings.ts` throws `MissingEmbeddingCredentialsError` and the knowledge source is marked `FAILED` with that exact message — verified live in a real browser in this session rather than assumed. Get a key at vercel.com; no other code change needed. |
| Vector storage | pgvector extension, `pgvector/pgvector:pg16` Docker image locally | Production needs a managed Postgres provider that supports the `vector` extension (Neon and Vercel Postgres both do) — not yet provisioned. |
| File storage | Local disk (`src/server/knowledge/storage.ts`, `.uploads/`, gitignored) | Explicitly dev-only and documented as such. Must be swapped for an S3-compatible adapter (Vercel Blob / R2 / S3) before production — the `StorageAdapter` interface is already shaped for that swap. |

## Phase 3 — Real-time voice MVP

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Real-time voice (speech ⇄ speech) | OpenAI Realtime API, or a comparable WebRTC-based provider | Must verify current region support, language/voice catalog, and session-token model before building the adapter |
| Transport | WebRTC (officially supported real-time protocol per the spec) | |

Session tokens must be short-lived and minted server-side; the embed widget never receives a permanent provider key (Part F.6, Part E).

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

- **Phase 2 (now):** `AI_GATEWAY_API_KEY` — the only thing currently blocked. Everything else (extraction, chunking, SSRF-protected crawling, local file storage) works without it.
- **Before production (any phase):** a managed Postgres provider with pgvector support, an S3-compatible object storage provider (to replace the local-disk adapter), and a linked Vercel project.
- **Phase 3:** realtime voice provider API key, domain(s) to allow-list for the embed widget.
- **Phase 4:** Paystack account + API keys, webhook signing secret.
- **Phase 6:** telephony provider account + API keys, phone number provisioning.

None of these blocked Phase 1 or the non-embedding parts of Phase 2.
