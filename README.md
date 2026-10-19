# Sunleon Voice

A multi-tenant SaaS platform for AI voice agents, built Ghana-first. See [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) for the full product vision and [docs/PHASE_STATUS.md](docs/PHASE_STATUS.md) for what's actually built right now.

This repository is being built in phases — see [docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md). Through Phase 2: authentication, organizations, role-based membership, a tenant-scoped dashboard, Agent Studio (versioned instructions, publish/rollback), and a knowledge base (FAQs, text, files, websites → chunked and embedded for retrieval). No real-time voice, billing, or telephony yet.

## Prerequisites

- Node.js 20+ (developed against Node 24)
- Docker (for local Postgres)

## Local setup

```bash
npm install --ignore-scripts
docker compose up -d
cp .env.example .env            # then set AUTH_SECRET: npx auth secret
npx prisma generate
npx prisma migrate dev
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
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:generate` | `prisma generate` |

## Documentation

All project documentation lives in [docs/](docs/): product spec, architecture, database design, security model, provider integration plan, roadmap, deployment runbook, testing strategy, known limitations, and the architectural decision log.
