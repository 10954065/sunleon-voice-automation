# Implementation Roadmap — Sunleon Voice

Status values: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `VERIFIED`. This table is the source of truth for sequencing; `docs/PHASE_STATUS.md` is the source of truth for the live status and the detailed per-phase report.

| Phase | Scope | Status |
|---|---|---|
| 0 | Audit and architecture | VERIFIED — this document set |
| 1 | Foundation: app shell, database, auth, orgs, roles, tenant authorization, dashboard layout, landing page, initial tests | VERIFIED |
| 2 | Agent Studio, knowledge ingestion, embeddings, tenant-scoped retrieval | BLOCKED (live embeddings need `AI_GATEWAY_API_KEY`) — see `docs/PHASE_STATUS.md` |
| 3 | Real-time voice MVP, embeddable widget | BLOCKED (built and tested up to the provider; live conversation needs `AI_GATEWAY_API_KEY`) — see `docs/PHASE_STATUS.md` |
| 4 | Usage metering, plans, billing, Paystack webhooks | BLOCKED (metering, limits and admin built and verified; live payments need `PAYSTACK_SECRET_KEY`) — see `docs/PHASE_STATUS.md` |
| 5 | Analytics, history, transcripts, leads, exports, retention, audit, admin console, monitoring | VERIFIED (AI summaries need `AI_GATEWAY_API_KEY`) — see `docs/PHASE_STATUS.md` |
| 6 | Telephony | NOT STARTED |
| 7 | Advanced voice, validated local languages, integrations | NOT STARTED |
| 8 | Production hardening | NOT STARTED |

## Sequencing rationale

Phases 1–4 are prioritized before telephony, custom voice, or advanced integrations, per the brief's launch strategy (Part L): the first commercial milestone is a pilot where a real business can configure an agent, upload knowledge, hold a real website voice conversation, embed it, and stay inside metered usage limits. Phases 5–8 harden and extend that pilot rather than racing ahead of it.

## Dependencies worth flagging now

- Phases 2 and 3 need one `AI_GATEWAY_API_KEY` with access to `openai/gpt-realtime-2` and `openai/text-embedding-3-small`. That single key unblocks real embeddings and real voice; nothing else in either phase waits on it (see `docs/PROVIDER_INTEGRATIONS.md`). Allowed embed domains are set per agent in Agent Studio.
- Phase 4 needs a Paystack account (secret key, GHS plans created in the Paystack dashboard, webhook URL). Without it, organizations are put on plans manually from `/admin/billing`.
- Phase 6 needs a telephony provider account and verified Ghanaian number availability.
- Production deployment (any phase) needs a managed Postgres provider with pgvector support, an S3-compatible object storage provider, and a linked Vercel project — none exist yet (`docs/DEPLOYMENT_RUNBOOK.md`).

None of these blocked Phase 1 or the bulk of Phase 2, both deliberately scoped to minimize external provider dependencies.
