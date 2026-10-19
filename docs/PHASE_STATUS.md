# Phase Status — Sunleon Voice

Last updated: 2026-10-19 (Phase 2 implementation).

| Phase | Status |
|---|---|
| 0 — Audit and architecture | VERIFIED |
| 1 — Foundation and authentication | VERIFIED |
| 2 — Agent Studio and knowledge ingestion | VERIFIED (embeddings credential-blocked — see below) |
| 3 — Real-time AI voice MVP | NOT STARTED |
| 4 — Usage, plans, and billing | NOT STARTED |
| 5 — Analytics and operational controls | NOT STARTED |
| 6 — Telephony | NOT STARTED |
| 7 — Advanced voice and integrations | NOT STARTED |
| 8 — Production hardening | NOT STARTED |

## Phase 1 — Foundation and authentication: VERIFIED

### What was built

- Next.js 16 (App Router, TypeScript strict, Tailwind v4) foundation.
- PostgreSQL via Prisma 7 (driver-adapter model: `prisma.config.ts` + `@prisma/adapter-pg`), running locally via Docker Compose.
- Authentication: Auth.js v5, Credentials provider, bcrypt password hashing, JWT sessions.
- Multi-tenancy: `Organization` / `Membership` (role enum: `SUPER_ADMIN`, `OWNER`, `ADMIN`, `AGENT_MANAGER`, `ANALYST`) / `AuditLog`, with server-side tenant resolution (`resolveMembership`) that never trusts a client-supplied org id.
- Registration, sign-in, workspace (organization) creation, team member listing/invite/role-change, tenant-scoped dashboard shell, public landing page.
- `proxy.ts` (Next.js 16's renamed `middleware.ts`) redirects unauthenticated visitors away from `/dashboard` and `/onboarding`; real enforcement stays server-side in `requireCurrentUser`/`requireOrgContext`.

### Acceptance criteria (from the master build prompt) — status

- "Users can authenticate and create workspaces" — **met**, verified in a real browser (see Testing below).
- "Tenant boundaries are tested" — **met**: `tests/integration/tenant-isolation.test.ts` proves a member of Org A cannot read/write Org B's data even when supplying Org B's slug directly.
- "Migrations work" — **met**: `prisma migrate dev` applied cleanly against local Postgres.
- "Lint, type checks, tests, and build pass" — **met**, see Quality Gates below.

### Quality gates — actual results

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | Clean, 0 errors/warnings |
| Typecheck | `npm run typecheck` | Clean, 0 errors |
| Unit + integration tests | `npm run test` | 34/34 passed, 9 test files |
| Coverage | `npm run test:coverage` | 67.52% statements / 45.45% branches / 69.56% functions / 67.24% lines — below the 80% target; gap and reasoning in `docs/KNOWN_LIMITATIONS.md` |
| Production build | `npm run build` | Succeeds |

### Manual verification (real browser, via Playwright)

Ran against the local dev server with a real Postgres container:

1. Landing page loads, no console errors.
2. Sign up (name/email/password) → account created → auto-signed-in → redirected to `/onboarding`.
3. Create workspace "Kente & Co." → organization + OWNER membership created → redirected to `/dashboard/kente-co`.
4. Dashboard overview shows the correct user, org, and role; no fabricated usage/agent data — explicit "not built yet" empty states instead.
5. Members page lists the OWNER; inviting a non-existent email is correctly rejected ("No account exists for that email yet.").
6. Navigating directly to a nonexistent/foreign org slug (`/dashboard/some-other-company`) returns a real 404 — no information leak.
7. Sign out → redirected to landing page.
8. Visiting `/dashboard/kente-co` while signed out → redirected to `/sign-in` by `proxy.ts`.
9. Sign in with the wrong password → rejected ("Invalid email or password."); correct password → signed in, redirected to the dashboard.

### Security controls implemented

- Passwords hashed with bcrypt (cost 12), never logged.
- Server-side session resolution only — no client-supplied tenant/user id is ever trusted.
- Role-based access control enforced in server actions (`requireRole`), not just hidden in the UI.
- Zod validation on every form input before it reaches the database.
- Audit log entries for org creation, member invites, and role changes.
- `.gitignore` excludes `.env*`, `.claude/`, `CLAUDE.md`, and the generated Prisma client.

### Required environment variables

See `.env.example`: `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_URL`.

### External accounts/credentials still needed

None for Phase 1 (by design). Phase 2 onward will need an embeddings provider, object storage, a realtime voice provider, Paystack, and a managed Postgres provider for production — none of these block Phase 1.

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` in full. Highlights: no rate limiting on auth endpoints yet, no email verification/password reset, no OAuth providers, no E2E test suite (Playwright was used manually for this phase's verification but isn't wired into CI yet), coverage below the 80% target with reasoning, no production database/Vercel project provisioned yet.

### Manual steps for the developer

1. Install Docker if not already present (it is, in this environment).
2. `npm install --ignore-scripts && docker compose up -d && cp .env.example .env` then set `AUTH_SECRET` via `npx auth secret`.
3. `npx prisma generate && npx prisma migrate dev && npm run dev`.
4. To provision production: choose and provision a managed Postgres (Neon or Vercel Postgres), link a Vercel project, set the three env vars there.

## Phase 2 — Agent Studio and knowledge ingestion: VERIFIED (embeddings credential-blocked)

### What was built

- **Agent Studio:** `Agent` + versioned `AgentVersion` model. Create, edit draft, publish, roll back, archive. Publishing locks the current draft (`publishedAt` set, `Agent.publishedVersionId` repointed) and the next edit creates a fresh draft version — publish history is append-only, never mutated. Rollback (OWNER/ADMIN only) just repoints `publishedVersionId`.
- **Knowledge base:** FAQ, manual text, website URL, and file (PDF/DOCX/TXT/MD/CSV) sources, each going through a real pipeline: extract → chunk → embed → store, with a `PENDING → PROCESSING → READY|FAILED` status and a visible error message, plus retry and delete.
- **Document extraction** (`src/server/knowledge/extract.ts`): real, local, no API key — `pdf-parse` (PDF), `mammoth` (DOCX), `csv-parse` (CSV), native read (TXT/MD), `cheerio` (HTML from crawled pages). Both `pdf-parse` and `mammoth` had breaking API changes since older assumptions; verified against their actual installed type definitions rather than guessed.
- **SSRF-protected website crawling** (`src/server/knowledge/ssrf.ts`): blocks non-HTTP(S) schemes, non-standard ports, `localhost`, and private/reserved/loopback/link-local IPs including the cloud metadata address `169.254.169.254`; validates every redirect hop, not just the first URL.
- **Chunking** (`src/server/knowledge/chunk.ts`): pure, deterministic paragraph-aware splitting with overlap for long paragraphs.
- **Embeddings** (`src/server/knowledge/embeddings.ts`): Vercel AI Gateway via the `ai` SDK, model `"openai/text-embedding-3-small"` (1536 dimensions), behind an `EmbeddingProvider` interface so tests can inject a fake instead of calling a real provider.
- **pgvector storage and retrieval** (`src/server/knowledge/retrieval.ts`): `KnowledgeChunk.embedding vector(1536)` with an HNSW cosine-distance index, added via hand-written raw-SQL migration (Prisma's classic schema generator has no native vector type — see `docs/DECISIONS.md`). `retrieveRelevantChunks` filters by both `organizationId` and `agentId` in the same query, never by chunk id alone.
- **Local-disk file storage** (`src/server/knowledge/storage.ts`): real file I/O, explicitly documented as dev-only; swappable for an S3-compatible adapter via the same `StorageAdapter` interface.
- **UI:** Agents list + create, agent detail page (draft editor, publish controls with version history, knowledge-source list with status badges, add-source tabs for FAQ/Text/Website/File).
- `docker-compose.yml` switched to `pgvector/pgvector:pg16`.

### Acceptance criteria (from the master build prompt) — status

- "Tenants can create agents" — **met**, verified in a real browser.
- "Index and retrieve their own knowledge" — **met for indexing** (extraction/chunking/storage all real and working); **retrieval is implemented and tenant-isolation-tested**, but produces no *meaningful* results yet because no real embeddings exist without `AI_GATEWAY_API_KEY` — this is a credential gap, not a code gap, and is reported as such rather than hidden.
- "Cannot access other tenants' data" — **met**: `tests/integration/knowledge.test.ts` proves a similarity search scoped to Org A never returns Org B's chunks, and every knowledge action verifies the target agent belongs to the caller's organization before touching it.

### Quality gates — actual results

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | Clean, 0 errors/warnings |
| Typecheck | `npm run typecheck` | Clean, 0 errors |
| Unit + integration tests | `npm run test` | 75/75 passed, 17 test files (up from 34/9 in Phase 1) |
| Coverage | `npm run test:coverage` | 71.42% statements / 59.6% branches / 84.61% functions / 71.49% lines — up from Phase 1's 67.52%, still below the 80% target; gap and reasoning in `docs/KNOWN_LIMITATIONS.md` |
| Production build | `npm run build` | Succeeds, 0 warnings (fixed a Turbopack file-tracing warning on the local storage adapter) |

### Manual verification (real browser, via Playwright)

Ran against a freshly recreated local Postgres container (pgvector image) and a restarted dev server (needed once — the long-running dev process had a stale cached `PrismaClient` singleton predating the new models; documented here so it doesn't surprise anyone):

1. Registered a fresh account, created org "Asante Textiles".
2. Created agent "Customer Support"; draft editor pre-filled with a sensible default instructions placeholder.
3. Edited instructions, saved draft → "Draft saved." confirmation.
4. Published → "Published as version 1.", publish button disabled (no unpublished changes), version history shows "v1 ... (live)".
5. Added a FAQ knowledge source → created immediately, pipeline ran, ended in **FAILED** with the exact message `AI_GATEWAY_API_KEY is not set...` — the honest, expected outcome with no credential configured, not a bug.
6. Clicked Retry → re-ran, same expected FAILED result (idempotent).
7. Clicked Delete → source removed, list returns to "No knowledge sources yet."
8. One real bug found and fixed during this verification: a form passed `encType="multipart/form-data"` alongside a function `action`, which React 19 flags as redundant/conflicting — removed.

### Security controls implemented (new this phase)

- SSRF protections for website knowledge sources (scheme/port/host/redirect validation against private and reserved IP ranges).
- File upload validation: extension allowlist + 10 MB size cap, enforced before the file reaches storage or extraction.
- Every Agent/KnowledgeSource/KnowledgeChunk query scoped by `organizationId`, matching the Phase 1 tenant-isolation pattern.
- Rollback restricted to OWNER/ADMIN server-side, with the UI button hidden for AGENT_MANAGER to match (caught and fixed during this phase, before it shipped).

### Required environment variables

See `.env.example`. New this phase: `AI_GATEWAY_API_KEY` (optional for everything except real embeddings — see Known Limitations).

### External accounts/credentials still needed

- `AI_GATEWAY_API_KEY` (Vercel AI Gateway) — the only thing currently blocking real embeddings/retrieval quality.
- Before production: a managed Postgres provider with pgvector support, an S3-compatible storage provider, and a linked Vercel project (same Phase 1 blockers, still open).

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` in full. Highlights: no embedding credential configured (verified live, not assumed), knowledge pipeline runs synchronously in-request (deliberate YAGNI call, not yet a background queue), website sources are a one-time crawl, a documented false-positive drift in `prisma migrate dev` around the hand-managed pgvector index (operational rule: never run it bare), PDF/DOCX extraction paths untested with real binary fixtures, plus the carried-over Phase 1 gaps (rate limiting, email verification, OAuth, MFA).

### Manual steps for the developer

1. `docker compose up -d` (now pulls `pgvector/pgvector:pg16` — first run will re-download the image if you had the old `postgres:16-alpine` volume; Phase 1 test data does not carry over since the volume was recreated during this phase's setup).
2. To unblock real embeddings: get an `AI_GATEWAY_API_KEY` from vercel.com and set it in `.env`. No code change needed.
3. Read the "Never run bare `npx prisma migrate dev`" rule in `docs/DECISIONS.md` and `docs/DEPLOYMENT_RUNBOOK.md` before touching the schema.

### Phase 3 acceptance criteria (for reference, not yet attempted)

A real browser can complete a real voice conversation with knowledge-based answers when credentials are configured. No permanent secret is exposed. Missing credentials are documented as blockers rather than mocked success.
