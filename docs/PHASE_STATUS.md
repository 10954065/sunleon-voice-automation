# Phase Status — Sunleon Voice

Last updated: 2026-10-22 (Phase 4 implementation).

| Phase | Status |
|---|---|
| 0 — Audit and architecture | VERIFIED |
| 1 — Foundation and authentication | VERIFIED |
| 2 — Agent Studio and knowledge ingestion | VERIFIED (embeddings credential-blocked — see below) |
| 3 — Real-time AI voice MVP | BLOCKED — built and tested up to the provider; live conversation needs `AI_GATEWAY_API_KEY` (see below) |
| 4 — Usage, plans, and billing | BLOCKED — metering, plans, limits and the admin console built and verified; live Paystack payments need `PAYSTACK_SECRET_KEY` (see below) |
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

## Phase 3 — Real-time AI voice MVP: BLOCKED (live conversation needs `AI_GATEWAY_API_KEY`)

Everything up to the provider boundary is built, tested against real Postgres, and checked in a real browser. The spoken conversation itself has **not** been tested, because no credential is configured. Per the brief, that is reported as a blocker, not as success.

### What was built

- **Provider adapter** (`src/server/voice/provider.ts`): `openai/gpt-realtime-2` through the Vercel AI Gateway realtime API, using the same `AI_GATEWAY_API_KEY` as Phase 2. It mints single-use, 60-second client secrets; the key never reaches the browser.
- **Secure session flow** (`src/server/voice/session.ts`, `src/app/api/voice/**`): prepare (dashboard auth + role, or signed embed ticket) → `Conversation` with a server-generated UUID → token route with atomic single-use issuance within 2 minutes → end route. Usage events: `SESSION_STARTED`, `SESSION_ENDED` (server duration plus a separately labelled client-reported duration), `TOOL_CALL`, `ERROR`.
- **Widget** (`src/components/voice-widget/*`, built on the AI SDK's `experimental_useRealtime`): consent and privacy notice; microphone permission with specific messages for denied, missing or busy microphones; connection states (connecting / listening / agent speaking); spoken replies; server VAD turn-taking and barge-in; an optional live transcript of the agent's speech; end call; a 15-minute client-side cap; cleanup on tab close and on navigation away; "Try again" starts a fresh session.
- **Embedding**: public iframe page `/widget/[agentId]` that checks the browser-set `Referer` against the agent's allowlist and issues an HMAC ticket. Agent Studio gains an "Allowed websites" editor (OWNER/ADMIN, audit-logged) and a copyable `<iframe allow="microphone">` snippet once published.
- **Knowledge grounding**: a bounded summary of READY knowledge in the instructions, plus a `search_knowledge` realtime tool executed against tenant-scoped pgvector retrieval. Instructions put platform rules first and fence knowledge as reference data.
- **Lead capture**: a form the visitor fills in themselves (not a model tool), only when enabled on the version that ran, after a session has started, at most 3 per conversation.
- **Agent Studio**: a voice picker (OpenAI's 10 documented realtime voices, labelled as unevaluated for Ghanaian English), a "Test voice" panel that tests the latest draft, "Recent voice sessions" (with failure reasons) and "Leads" lists.
- **Fixes found along the way**: `.env.example` had never been committed (the `.env*` ignore rule swallowed it); duplicate `id="name"` on three forms broke label association after client-side navigation; stale "voice comes in a later phase" copy; `SECURITY_MODEL.md` wrongly said sessions were database-backed (they're JWT).

### Acceptance criteria (from the master build prompt) — status

| Criterion | Status |
|---|---|
| A real browser completes a real voice conversation with knowledge-based answers when credentials are configured | **BLOCKED** — no `AI_GATEWAY_API_KEY`. All code paths up to the provider are built and tested. |
| No permanent secret is exposed | **Met** — key is server-only; browser receives single-use 60 s secrets; public errors never mention configuration (tested). |
| Missing credentials are documented as blockers rather than mocked success | **Met** — honest blocker messages verified in the browser; real token route tested failing with 503 and marking the conversation FAILED. |

### Quality gates — actual results

- `npx tsc --noEmit`: clean.
- `npx eslint`: 0 errors. One warning, from the generated `coverage/` report folder; a config-protection hook blocks adding it to the ESLint ignores, and it doesn't affect CI, which lints before coverage exists.
- `npx vitest run --coverage`: **158 tests in 25 files, all passing.** Statements 77.92%, lines 78.05%, `src/server/voice` 94.1%. Below the 80% target for the same reasons as Phase 2 (Auth.js wrappers, real-network fetcher branches, PDF/DOCX extraction).
- `npm run build`: succeeds; all six voice API routes and `/widget/[agentId]` present.
- Migrations: `20261019092647_phase3_voice_mvp`, `20261019094202_phase3_conversation_token_issued` — reviewed, Prisma's spurious `DROP INDEX` removed from both, applied with `migrate deploy`, pgvector index confirmed intact.
- Security review (separate reviewer agent): one HIGH (cost abuse via spoofable IP key and ticket replay), one MEDIUM (leads accepted without a started session), one LOW (raw provider errors to dashboard users). All three fixed and covered by tests: a per-agent preparation ceiling that no header can influence, a started-session requirement for leads, and truncated dashboard errors. A separate code-quality review was stopped before it reported; the widget lifecycle was then self-reviewed (it found and fixed missing microphone/session cleanup on client-side navigation).

### Manual verification (real browser, via Playwright, no credentials)

- Sign-up → workspace → agent → instructions, Cedar voice, lead capture → save → publish → allowed website `localhost` → embed snippet shown with the correct URL.
- Dashboard "Test voice" with microphone granted: shows *"Voice is not configured: AI_GATEWAY_API_KEY is not set…"*, and no session row is created.
- Microphone denied: *"Microphone access was blocked. Allow microphone access for this page in your browser, then try again."*
- Embedded on a stand-in business page at `localhost:8788` (allowed): consent screen; starting shows *"Voice is temporarily unavailable"* (no configuration details).
- The same page at `127.0.0.1:8788` (not allowed), a direct visit to `/widget/<id>`, and an unknown agent id all show the identical *"This voice assistant isn't available on this page."*
- The widget page HTML contains the consent text and ticket but **not** the business instructions or greeting.

### Live-session checklist — run once `AI_GATEWAY_API_KEY` is set

1. Dashboard test call connects; the agent greets with the configured greeting in the selected voice.
2. Ask a question answered only by a READY knowledge source → correct answer; a `TOOL_CALL` usage event appears.
3. Talk over the agent → playback stops (barge-in).
4. Ask something not in the knowledge → the agent says it doesn't know and offers a human; it doesn't invent an answer.
5. End the call → session shows `completed` with a duration; `SESSION_ENDED` carries `clientReportedSeconds`.
6. Repeat 1–5 through the embed snippet on an allowed host; submit a lead → it appears under Leads.
7. Listen for Ghanaian-English pronunciation of local names, places and cedi amounts; record findings (Decision 3) before claiming any quality.

### Security controls implemented (new this phase)

Single-use, short-lived provider secrets; server-generated UUID conversation ids; tenant scope derived only from the conversation row on public routes; Referer allowlist plus HMAC embed tickets with an allowlist re-check; published-only public path; OWNER/ADMIN-only, audit-logged allowlist changes; public error hygiene; per-IP and per-agent rate limits; lead capture gated on a started session and the version's setting; prompt-injection framing. Full detail in `docs/SECURITY_MODEL.md`.

### Required environment variables

No new variables. `AI_GATEWAY_API_KEY` now also powers voice and needs access to `openai/gpt-realtime-2`. `NEXTAUTH_URL` is also the base URL shown in embed snippets.

### External accounts/credentials still needed

- `AI_GATEWAY_API_KEY` (Vercel) — unblocks both Phase 2 embeddings and Phase 3 voice.
- Before production: managed Postgres with pgvector, S3-compatible storage, a durable rate limiter (e.g. Upstash Redis), and a linked Vercel project.

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` → "Phase 3 — real-time voice". The most important ones: instructions are visible to callers (the Gateway applies session config from the browser), session length is capped only client-side, usage isn't billing-grade, and rate limiting is per-process.

### Manual steps for the developer

1. Set `AI_GATEWAY_API_KEY` in `.env`, restart `npm run dev`, then run the live-session checklist above.
2. Apply migrations with `npx prisma migrate deploy` (never answer `migrate dev`'s prompt — see `docs/DECISIONS.md`).
3. Note that `npm run test` wipes the local dev database.

## Phase 4 — Usage, plans, and billing: BLOCKED (live payments need `PAYSTACK_SECRET_KEY`)

Metering, plans, entitlements, limits, warnings, cost estimates and the admin console are built, tested against real Postgres, and checked in a real browser. The Paystack integration is built to Paystack's published API and webhook scheme and tested with a test double at the provider boundary. **No real Paystack payment has been made**, because no Paystack account is configured. Per the brief, that is reported as a blocker, not as success.

### What was built

- **Plans** (`Plan`): configurable price (GHS minor units), included minutes, simultaneous-session limit, agent limit, optional overage rate, warning threshold, trial window, self-serve vs private, Paystack plan link. Seeded by migration with the brief's illustrative Trial (free, 10 min, 14 days), Starter (GHS 299, 150 min) and Growth (GHS 799, 500 min). Overage is off on every plan until real costs are measured.
- **Entitlements** (`src/server/billing/entitlements.ts`): a subscription grants its plan only while now is before its paid-through date, whatever its status, so a missed renewal lapses on its own. New organizations get the trial once; a lapsed paid plan never falls back to it. With no plan, voice and new agents are blocked.
- **Usage ledger** (`UsageLedgerEntry`): one row per session, `quantity` = seconds measured by our server from token issue to end (client-reported time is kept only as a labelled comparison), attributed to organization, agent, conversation, provider and model, with a cost-estimate snapshot. A unique idempotency key per session plus an atomic ACTIVE → COMPLETED claim mean retried ends, beacons and sweeps can never count a session twice.
- **Limits, enforced server-side** (`src/server/billing/quota.ts`): when a session is prepared, a per-organization Postgres advisory lock serialises the check. It sweeps abandoned sessions, then checks the plan, the simultaneous-session limit and the remaining allowance (included minutes + the overage the owner pre-approved − used − time held by live sessions). It reserves at most 15 minutes, and the reservation becomes the widget's cut-off. Public visitors see a generic message; dashboard users see why.
- **Overage budget**: owner-set monthly cap. Overage time = budget ÷ the plan's overage rate; usage can never run past it. 0 (the default) means a hard stop at the included minutes.
- **Abandoned sessions**: closed by the organization's next session preparation and by a protected cron route (`/api/cron/sweep-sessions`, `CRON_SECRET`, daily via `vercel.json`). A session that got a token but never reported its end is charged its full reservation — a conservative estimate, documented.
- **Warnings**: one alert per period at the warning threshold (80% by default) and one when the included minutes are used up (`UsageAlert`, unique per period). Shown on the Overview and Billing pages. Not emailed — no email provider yet.
- **Agent limit**: `createAgent` counts active agents under the same lock.
- **Paystack adapter** (`src/server/billing/paystack.ts`, `charges.ts`, `webhooks.ts`): checkout via Initialize Transaction with a plan code (amount, currency and plan from our `Plan` row; our own `slv_<uuid>` reference). The webhook verifies `X-Paystack-Signature` (HMAC-SHA512 of the raw body, timing-safe) and deduplicates on SHA-256 of the body. It re-verifies every `charge.success` with Paystack's API, checks amount, currency and plan, and maps tenants only through records we created. It handles `subscription.create` (out-of-order arrival answers 503 so Paystack retries), on-time and late renewals, `invoice.payment_failed` (past due; access runs to the paid-through date), `subscription.not_renew` and `subscription.disable`. The return page verifies the payment directly, through the same idempotent path. Owners cancel through Paystack's disable endpoint; access runs to the end of the paid month.
- **Billing page** (`/dashboard/[orgSlug]/billing`): current plan and status, usage this period with a progress bar, live sessions, remaining time, overage charge (capped at the budget), overage budget form, plans, cancel, billing history.
- **Platform admin console** (`/admin/billing`): edit and create plans, set the voice cost rate (GHS per minute, with a required source note), a per-organization current-period report (minutes, estimated cost, revenue, margin; "unknown" margin when usage is unpriced), manual plan assignment (enterprise, pilots, or while Paystack is blocked), recent webhook events and rejected payments. Access is a `User.isPlatformAdmin` flag checked against the database on every request, with no UI to grant it; non-admins get a 404.
- **Fixes found along the way**: CI had never passed — it used a Postgres image without pgvector, and typecheck needed Next.js's generated route types (`npm run typecheck` now runs `next typegen` first). The Paystack response schema wrongly required a `data` field, which would have reported every successful cancellation as a failure (caught by tests).

### Acceptance criteria (from the master build prompt) — status

| Criterion | Status |
|---|---|
| Usage is correctly attributed | **Met** — every ledger row carries organization, agent, conversation, provider and model from the conversation row; tenant isolation of summaries tested. |
| Duplicate events cannot double-count | **Met** — unique ledger key per session plus an atomic claim (5 concurrent ends → 1 row); webhook bodies deduplicated by hash, charges by reference (4 concurrent deliveries → processed once); all tested. |
| Entitlements are enforced | **Met** — plan, simultaneous sessions, minutes and agent count are checked server-side under a lock; 6 parallel prepares against a limit of 2 → exactly 2 succeed; tested. |
| Usage exhaustion cannot create uncontrolled bills | **Met, with one documented gap** — no session starts without allowance; each is capped at its reservation; the overage charge is capped at the owner's budget. The gap: the provider session runs in the visitor's browser, so a tampered client could keep talking past its cut-off at our cost, not the customer's (KNOWN_LIMITATIONS). |
| Payment integration with verified webhooks | **BLOCKED** — built and tested with signed payloads and a test double; no live Paystack account. |

### Quality gates — actual results

- `npm run typecheck` (now `next typegen && tsc --noEmit`): clean.
- `npm run lint`: 0 errors, 1 warning (the generated `coverage/` folder, as before).
- `npm run test:coverage`: **246 tests in 31 files, all passing.** Statements **83.89%** (above the 80% target for the first time); `src/server/billing` ~89%.
- `npm run build`: succeeds; `/dashboard/[orgSlug]/billing`, `/admin/billing`, `/api/webhooks/paystack` and `/api/cron/sweep-sessions` present.
- Migrations: `20261022131745_phase4_billing` (spurious `DROP INDEX` removed; adds CHECK constraints so usage, budgets and limits can't go negative; seeds the three plans) and `20261022140000_phase4_subscription_billing_anchor` (hand-written column renames). Applied with `migrate deploy`; `migrate diff` shows only the known pgvector-index false positive.
- CI on GitHub: first green run 39783255519 (just before Phase 4). Check the Actions tab for the Phase 4 commit's run.

### Manual verification (real browser, via Playwright, no Paystack key)

- New workspace → Overview shows "Trial — 0 min of 10 min"; Billing shows the trial end date, the period, a usage bar, and "Online payment isn't switched on yet (Paystack isn't configured)" with no buy buttons.
- Owner saved an overage budget of GHS 25 → "Overage budget saved.", stored as 2500 pesewas and audit-logged. (This found a display bug — the field showed the trial's effective 0 — now fixed.)
- `/admin/billing` as a non-admin owner → 404; signed out → redirect to sign-in; after the documented SQL grant → the console loads with plans, report and events.
- Admin assigned Growth for 2 months → "Kofi Bakery is on Growth for 2 month(s)."; the organization's billing page shows "Growth — Active until 22 Dec 2026", the period 22 Oct – 22 Nov, and a Cancel button for the owner.
- Over HTTP: `POST /api/webhooks/paystack` → 503 `not_configured`, nothing stored; `GET /api/cron/sweep-sessions` without `CRON_SECRET` → 503.

### Paystack checklist — run once `PAYSTACK_SECRET_KEY` (test mode) is set

1. In the Paystack dashboard create monthly GHS plans matching Starter and Growth; paste their `PLN_` codes in `/admin/billing`.
2. Set the webhook URL to `https://<host>/api/webhooks/paystack` (use a tunnel for local testing).
3. As an owner, choose Starter → Paystack test checkout → the return page says "Payment confirmed"; the plan shows Starter and history shows the payment.
4. In `/admin/billing` → Recent events: `charge.success` and `subscription.create` processed; the subscription now has its codes.
5. Cancel → Paystack shows the subscription disabled; Billing shows "Cancelled — active until …".
6. Resend an event from the Paystack dashboard → recorded once (duplicate).
7. Confirm Paystack's current payment methods for GHS (card, mobile money) and record them.

### Security controls implemented (new this phase)

Webhook HMAC-SHA512 verification over the raw body with constant-time comparison; no action without a configured secret; body-hash idempotency; server-side re-verification of charges; amount/currency/plan matching; tenant mapping only through our own references and stored codes; checkout amounts chosen by the server; redirects only to HTTPS `paystack.com` hosts; minimal webhook summaries (no card or authorization data); OWNER/ADMIN for checkout, OWNER for cancel and budget; a database-checked platform-admin flag with no grant UI; all billing and admin changes audit-logged; quota checks serialised by an advisory lock; database CHECK constraints on usage and money columns; a secret-protected cron route. Full detail in `docs/SECURITY_MODEL.md`.

### Required environment variables

- `PAYSTACK_SECRET_KEY` — new, optional; without it checkout and webhooks are BLOCKED (manual plan assignment still works).
- `CRON_SECRET` — new; required for the cron sweep route (sessions are still swept per organization without it).

### External accounts/credentials still needed

- Paystack account (test, then live keys) with GHS plans and the webhook URL configured.
- `AI_GATEWAY_API_KEY` (Phases 2–3) — still needed for live voice and embeddings.
- Measured provider costs, to set a real voice cost rate (margins show "unknown" until then).

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` → "Phase 4 — billing". The most important: no live Paystack payment yet; overage is computed and capped but invoiced manually; plan changes need cancel-then-subscribe (no proration); usage alerts are in-app only; the cost rate is an admin-entered estimate.

### Manual steps for the developer

1. `npx prisma migrate deploy`.
2. Grant yourself platform admin: `UPDATE "User" SET "isPlatformAdmin" = true WHERE email = '<you>';` (see `docs/DEPLOYMENT_RUNBOOK.md`).
3. Set `CRON_SECRET`; set `PAYSTACK_SECRET_KEY` and run the Paystack checklist above.
4. Enter a voice cost rate in `/admin/billing` once real provider charges are known.

### Phase 5 acceptance criteria (for reference, not yet attempted)

Analytics reflect real events, access is authorized, and retention and deletion behavior is tested.
