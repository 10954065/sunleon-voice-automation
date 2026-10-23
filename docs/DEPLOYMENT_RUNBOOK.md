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

# 5. Apply database migrations (deploy applies pending ones without the interactive drift prompt)
npx prisma migrate deploy

# 6. Run the app
npm run dev
```

**Prisma 7 note:** this project uses Prisma 7's new configuration model — connection URLs live in `prisma.config.ts` (CLI/migrations) and in the `PrismaPg` driver adapter passed to `PrismaClient` (`src/server/db/client.ts`), not in `schema.prisma`'s `datasource` block. The generated client lives at `src/generated/prisma/` (gitignored) and must be regenerated with `npx prisma generate` after cloning or after any `schema.prisma` change. Also note: npm's `prisma` package currently publishes its `latest` dist-tag pointing at an `8.0.0-rc` release candidate while `@prisma/client`'s `latest` is the stable `7.10.1` — this project pins `prisma` to `7.10.1` explicitly in `package.json` to keep both packages on the same stable major version. Re-check this before ever running `npm update` on either package.

**pgvector note (Phase 2):** `docker-compose.yml` uses `pgvector/pgvector:pg16`, not plain `postgres:16-alpine` — the `KnowledgeChunk.embedding` column and its similarity-search index need the `vector` extension. If you ever switch Postgres images or providers, confirm `vector` is available first.

**⚠️ Never run bare `npx prisma migrate dev` on this project.** To create a migration: `npx prisma migrate dev --create-only --name <name>`, read the generated `migration.sql`, and remove any `DROP INDEX "KnowledgeChunk_embedding_cosine_idx"` (or drop of the `embedding` column) — that's Prisma's drift detection fighting a hand-managed pgvector index it can't express in `schema.prisma`, not a real required change. To apply: `npx prisma migrate deploy`. Bare `migrate dev` also opens an interactive "name the new migration" prompt that never returns in a non-interactive shell and keeps holding Postgres's migration lock. Full explanation in `docs/DECISIONS.md`.

**Tests share the dev database.** `npm run test` resets the `sunleon_voice` database, wiping any data you created by hand in `npm run dev`.

**Testing voice locally.** The dashboard's "Test voice" panel needs `AI_GATEWAY_API_KEY`. To test the embedded widget, serve any page on a hostname listed in the agent's "Allowed websites" (e.g. a page on `localhost:<another port>` with `localhost` allowed) containing the snippet from Agent Studio. Browsers only grant microphone access on `https://` or `localhost`.

**Dev server and builds.** Stop `npm run dev` before running `npm run build` or `npm run typecheck` (`next typegen`): both write into `.next/`. In Phase 5 a stale `.next/` made the dev server recompile and reload pages in a loop. If that happens, stop the server, delete `.next/` and start it again.

**Note on `--ignore-scripts`:** this machine's npm config restricts install scripts to an explicit allowlist (`allow-scripts` in `~/.npmrc`), as a supply-chain-attack guardrail. `--ignore-scripts` was used to scaffold this project because none of the current dependencies (Next.js, Prisma, Tailwind, Auth.js) require install-time scripts for correct operation on this platform. If a future dependency does need a postinstall step (e.g., a native binary build), add it explicitly to the allowlist rather than disabling the guardrail wholesale.

## Required environment variables

See `.env.example` for the authoritative list.

| Variable | Purpose | Required since |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Phase 1 |
| `AUTH_SECRET` | Auth.js session encryption secret (generate with `npx auth secret`) | Phase 1 |
| `NEXTAUTH_URL` | Base URL of the app (e.g. `http://localhost:3000` locally) | Phase 1 |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key, server-side only. Phase 2: knowledge-base embeddings. Phase 3: minting single-use realtime voice tokens for `openai/gpt-realtime-2` (the key's team must have access to that model). Without it, knowledge sources fail at the embedding step and voice sessions refuse to start, both with a clear error — see `docs/KNOWN_LIMITATIONS.md`. | Phase 2 (voice: Phase 3) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key, server-side only. Starts checkouts, verifies transactions, cancels subscriptions, and verifies webhook signatures. Optional: without it, online payment and the webhook are BLOCKED (503) and plans are assigned manually in `/admin/billing`. | Phase 4 |
| `CRON_SECRET` | Bearer secret for `/api/cron/sweep-sessions` and `/api/cron/retention` (Vercel Cron sends it automatically when set in the project). Without it both routes answer 503: sessions are still swept per organization, but **retention deletions don't run**. | Phase 4 |

## Platform admin and billing setup (Phase 4)

1. **Grant platform admin** to an operator who has already signed up. There is deliberately no UI for this:
   ```sql
   UPDATE "User" SET "isPlatformAdmin" = true WHERE email = 'operator@example.com';
   ```
   (Locally: `docker compose exec -T postgres psql -U sunleon -d sunleon_voice -c "<the statement>"`.) Revoke by setting it to `false`; it takes effect on the next request.
2. In `/admin/billing`, review the seeded plans (Trial, Starter, Growth — illustrative values) and enter a **voice cost rate** once real Gateway charges are known.
3. **Paystack** (when the account exists): set `PAYSTACK_SECRET_KEY`; create matching monthly GHS plans in the Paystack dashboard and paste each `PLN_` code into the plan; set the webhook URL to `https://<host>/api/webhooks/paystack`; then run the Paystack checklist in `docs/PHASE_STATUS.md`.
4. **Cron:** `vercel.json` schedules `/api/cron/sweep-sessions` daily at 03:00 UTC and `/api/cron/retention` at 03:30 UTC (the Hobby plan allows at most daily runs; if a plan refuses two cron jobs, call both routes from one schedule). Set `CRON_SECRET` in the Vercel project. `/admin/monitoring` shows each job's last run and flags one that hasn't succeeded in 26 hours.

## Monitoring (Phase 5)

- Point an uptime monitor at `GET /api/health` (200 `{"status":"ok"}`, or 503 when the database is unreachable).
- Check `/admin/monitoring` regularly: there is no alerting yet. Server errors also appear as JSON lines (`"level":"error"`) in the host's logs.
- To test retention by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/retention`.

## Production deployment (planned, not yet done)

1. Provision a managed Postgres database with pgvector support (Neon or Vercel Postgres via the Vercel Marketplace — both support the `vector` extension). **Blocker:** not yet provisioned.
2. Create and link a Vercel project. **Blocker:** Vercel CLI is not installed in this environment and no project has been linked.
3. Set the environment variables above in the Vercel project's environment settings (never commit real values), with `NEXTAUTH_URL` set to the public HTTPS URL — it is also the base URL shown in embed snippets. Also provision an S3-compatible storage provider before relying on file-upload knowledge sources in production (the local-disk adapter is dev-only), and replace the in-memory voice rate limiter with a durable one (e.g. Upstash Redis via the Vercel Marketplace).
4. Run `npx prisma migrate deploy` against the production database as part of the deploy pipeline (not `migrate dev`, which is for local schema iteration only).
5. Deploy via `vercel deploy --prod` or a connected Git integration.

## Rollback strategy

- Application: redeploy the previous Vercel deployment (instant, Vercel keeps immutable deployments).
- Database: Prisma migrations are forward-only by default in this plan. Before any destructive migration (column drop, type change) ships, write and test a corresponding down-migration or a verified backup/restore step. No destructive migrations exist yet in Phase 1.

## Backups

Not yet configured — depends on the managed Postgres provider chosen. Must be configured before any real customer data is stored (Phase 8 hardening checklist explicitly requires backup-restore testing).
