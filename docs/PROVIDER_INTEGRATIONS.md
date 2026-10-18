# Provider Integrations — Sunleon Voice

## Status

**Phase 1 has zero external provider dependencies by design.** No AI, voice, payment, or telephony provider is integrated yet. This is deliberate: it keeps Phase 1 (auth, orgs, roles, dashboard shell) fully buildable and testable without waiting on any external account or credential.

Everything below is an **evaluation plan** for later phases, not a claim that these integrations exist or that pricing/capabilities have been verified against current provider documentation. Each will be re-verified against official docs immediately before it is implemented, per Part D: "Use official, current provider documentation... Never invent APIs or assume an account has access to a feature."

## Phase 2 — Knowledge ingestion & retrieval

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Document parsing (PDF/DOCX) | `pdf-parse`, `mammoth`, or a hosted extraction API | Choose based on accuracy vs. self-hosting cost |
| Embeddings | OpenAI embeddings, or a Vercel AI Gateway-routed provider | Must confirm current model availability/pricing before committing |
| Vector storage | pgvector extension on the chosen Postgres provider | Requires a Postgres provider that supports the extension |

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

- **Phase 2:** embeddings provider API key, object storage credentials.
- **Phase 3:** realtime voice provider API key, domain(s) to allow-list for the embed widget.
- **Phase 4:** Paystack account + API keys, webhook signing secret.
- **Phase 6:** telephony provider account + API keys, phone number provisioning.

None of these are required for, or block, Phase 1.
