# Implementation Roadmap — Sunleon Voice

Status values: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `VERIFIED`. This table is the source of truth for sequencing; `docs/PHASE_STATUS.md` is the source of truth for the live status and the detailed per-phase report.

| Phase | Scope | Status |
|---|---|---|
| 0 | Audit and architecture | VERIFIED — this document set |
| 1 | Foundation: app shell, database, auth, orgs, roles, tenant authorization, dashboard layout, landing page, initial tests | See `docs/PHASE_STATUS.md` |
| 2 | Agent Studio, knowledge ingestion, embeddings, tenant-scoped retrieval | NOT STARTED |
| 3 | Real-time voice MVP, embeddable widget | NOT STARTED |
| 4 | Usage metering, plans, billing, Paystack webhooks | NOT STARTED |
| 5 | Analytics, leads, admin console, audit history | NOT STARTED |
| 6 | Telephony | NOT STARTED |
| 7 | Advanced voice, validated local languages, integrations | NOT STARTED |
| 8 | Production hardening | NOT STARTED |

## Sequencing rationale

Phases 1–4 are prioritized before telephony, custom voice, or advanced integrations, per the brief's launch strategy (Part L): the first commercial milestone is a pilot where a real business can configure an agent, upload knowledge, hold a real website voice conversation, embed it, and stay inside metered usage limits. Phases 5–8 harden and extend that pilot rather than racing ahead of it.

## Dependencies worth flagging now

- Phase 2 needs an embeddings provider and object storage credentials.
- Phase 3 needs a realtime voice provider and a decision on allowed embed domains.
- Phase 4 needs a Paystack account.
- Phase 6 needs a telephony provider account and verified Ghanaian number availability.
- Production deployment (any phase) needs a managed Postgres provider and a linked Vercel project — neither exists yet (`docs/DEPLOYMENT_RUNBOOK.md`).

None of these block Phase 1, which was deliberately scoped to have zero external provider dependencies.
