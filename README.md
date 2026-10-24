# Sunleon Voice

A multi-tenant SaaS platform for AI voice agents, built Ghana-first. See [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) for the full product vision and [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) for what's actually built right now.

This repository is being built in phases — see [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md). Through Phase 6: authentication, organizations, role-based membership, a tenant-scoped dashboard, Agent Studio (versioned instructions, voice selection, publish/rollback), a knowledge base (FAQs, text, files, websites → chunked and embedded for retrieval), and real-time browser voice (dashboard test calls plus an embeddable iframe widget with per-agent allowed websites, knowledge grounding and lead capture). Phase 4 adds usage metering, plans, server-enforced limits and Paystack billing. Phase 5 adds analytics, conversation history with consented transcripts and on-request AI summaries, leads, CSV exports, retention controls and erasure, audit logs, and a platform console with monitoring and error reporting. Phase 6 adds phone calls: Twilio numbers answered by the agent through OpenAI Realtime over SIP, authorized call-backs, transfer to a person, a do-not-call list and daily usage reconciliation (see [docs/USAGE_RECONCILIATION.md](docs/USAGE_RECONCILIATION.md)). Live voice, embeddings and summaries need `AI_GATEWAY_API_KEY`; online payments need `PAYSTACK_SECRET_KEY`; phone calls need Twilio and OpenAI credentials. Without them those features fail with a clear message.

## Prerequisites

- Node.js 20+ (developed against Node 24)
- Docker (for local Postgres)

## Local setup

```bash
npm install --ignore-scripts
docker compose up -d
cp .env.example .env            # then set AUTH_SECRET: npx auth secret
npx prisma generate
npx prisma migrate deploy
npm run dev
```

Open http://localhost:3000.

Install scripts are disabled deliberately on some machines as a supply-chain guardrail — `--ignore-scripts` is safe here because none of the current dependencies need an install-time script. See [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md) if a future dependency does need one.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Run the Vitest suite (needs the Postgres container running) |
| `npm run test:coverage` | Same, with a coverage report |
| `npm run db:migrate` | `prisma migrate dev` — read the migration rule in [docs/DECISIONS.md](docs/DECISIONS.md) first; use `npx prisma migrate deploy` to apply |
| `npm run db:generate` | `prisma generate` |

## Documentation

All project documentation lives in [docs/](docs/): product spec, architecture, database design, security model, provider integration plan, roadmap, deployment runbook, testing strategy, known limitations, and the architectural decision log.
