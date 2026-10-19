# Deployment Runbook — Sunleon Voice

## Status

Covers **local development** (working today) and **intended production deployment** (not yet executed — no Vercel project or managed database has been provisioned in this session).

## Local development setup

Prerequisites: Node.js 20+, Docker, npm.

```bash
# 1. Install dependencies (install scripts are intentionally restricted on this machine —
#    see the note below before assuming --ignore-scripts is safe on a different machine)
npm install --ignore-scripts

# 2. Start local Postgres
docker compose up -d

# 3. Copy environment template and fill in local values
cp .env.example .env            # then set AUTH_SECRET: npx auth secret

# 4. Generate the Prisma client (required — Prisma 7 generates into src/generated/prisma,
#    which is gitignored, so this must be run after every fresh clone/install)
npx prisma generate

# 5. Apply database migrations
npx prisma migrate dev

# 6. Run the app
npm run dev
```

**Prisma 7 note:** this project uses Prisma 7's new configuration model — connection URLs live in `prisma.config.ts` (CLI/migrations) and in the `PrismaPg` driver adapter passed to `PrismaClient` (`src/server/db/client.ts`), not in `schema.prisma`'s `datasource` block. The generated client lives at `src/generated/prisma/` (gitignored) and must be regenerated with `npx prisma generate` after cloning or after any `schema.prisma` change. Also note: npm's `prisma` package currently publishes its `latest` dist-tag pointing at an `8.0.0-rc` release candidate while `@prisma/client`'s `latest` is the stable `7.10.1` — this project pins `prisma` to `7.10.1` explicitly in `package.json` to keep both packages on the same stable major version. Re-check this before ever running `npm update` on either package.

**pgvector note (Phase 2):** `docker-compose.yml` uses `pgvector/pgvector:pg16`, not plain `postgres:16-alpine` — the `KnowledgeChunk.embedding` column and its similarity-search index need the `vector` extension. If you ever switch Postgres images or providers, confirm `vector` is available first.

**⚠️ Never run bare `npx prisma migrate dev` on this project.** Always use `npx prisma migrate dev --create-only`, read the generated `migration.sql`, and delete it without applying if it tries to `DROP INDEX "KnowledgeChunk_embedding_cosine_idx"` or drop the `embedding` column — that's Prisma's drift detection fighting a hand-managed pgvector index it can't express in `schema.prisma`, not a real required change. Full explanation in `docs/DECISIONS.md`.

**Note on `--ignore-scripts`:** this machine's npm config restricts install scripts to an explicit allowlist (`allow-scripts` in `~/.npmrc`), as a supply-chain-attack guardrail. `--ignore-scripts` was used to scaffold this project because none of the current dependencies (Next.js, Prisma, Tailwind, Auth.js) require install-time scripts for correct operation on this platform. If a future dependency does need a postinstall step (e.g., a native binary build), add it explicitly to the allowlist rather than disabling the guardrail wholesale.

## Required environment variables

See `.env.example` for the authoritative list.

| Variable | Purpose | Required since |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Phase 1 |
| `AUTH_SECRET` | Auth.js session encryption secret (generate with `npx auth secret`) | Phase 1 |
| `NEXTAUTH_URL` | Base URL of the app (e.g. `http://localhost:3000` locally) | Phase 1 |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key for knowledge-base embeddings. Without it, sources still validate/extract/chunk but fail (visibly, with a clear error) at the embedding step — see `docs/KNOWN_LIMITATIONS.md`. | Phase 2 |

## Production deployment (planned, not yet done)

1. Provision a managed Postgres database with pgvector support (Neon or Vercel Postgres via the Vercel Marketplace — both support the `vector` extension). **Blocker:** not yet provisioned.
2. Create and link a Vercel project. **Blocker:** Vercel CLI is not installed in this environment and no project has been linked.
3. Set the environment variables above in the Vercel project's environment settings (never commit real values). Also provision an S3-compatible storage provider before relying on file-upload knowledge sources in production — the local-disk adapter is dev-only.
4. Run `npx prisma migrate deploy` against the production database as part of the deploy pipeline (not `migrate dev`, which is for local schema iteration only).
5. Deploy via `vercel deploy --prod` or a connected Git integration.

## Rollback strategy

- Application: redeploy the previous Vercel deployment (instant, Vercel keeps immutable deployments).
- Database: Prisma migrations are forward-only by default in this plan. Before any destructive migration (column drop, type change) ships, write and test a corresponding down-migration or a verified backup/restore step. No destructive migrations exist yet in Phase 1.

## Backups

Not yet configured — depends on the managed Postgres provider chosen. Must be configured before any real customer data is stored (Phase 8 hardening checklist explicitly requires backup-restore testing).
