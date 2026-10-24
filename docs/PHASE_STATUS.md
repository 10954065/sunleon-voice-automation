# Phase Status — Sunleon Voice

Last updated: 2026-10-24 (Phase 6 implementation).

| Phase | Status |
|---|---|
| 0 — Audit and architecture | VERIFIED |
| 1 — Foundation and authentication | VERIFIED |
| 2 — Agent Studio and knowledge ingestion | VERIFIED (embeddings credential-blocked — see below) |
| 3 — Real-time AI voice MVP | BLOCKED — built and tested up to the provider; live conversation needs `AI_GATEWAY_API_KEY` (see below) |
| 4 — Usage, plans, and billing | BLOCKED — metering, plans, limits and the admin console built and verified; live Paystack payments need `PAYSTACK_SECRET_KEY` (see below) |
| 5 — Analytics and operational controls | VERIFIED — history, analytics, leads, exports, retention, audit, admin, monitoring and error reporting built and tested; AI summaries need `AI_GATEWAY_API_KEY` (see below) |
| 6 — Telephony | BLOCKED — inbound and authorized outbound calling, webhooks, lifecycle, metering, transfer, handoff, consent, opt-out, failure recovery and reconciliation built and tested up to both providers; a live test call needs a Twilio account with a number and an OpenAI API key, webhook secret and project (see below) |
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
- CI on GitHub: first green run 39783255519 (just before Phase 4); the Phase 4 commit `e9ad0ed` passed in run 39826613181.

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

## Phase 5 — Analytics and operational controls: VERIFIED (AI summaries credential-blocked)

Everything in the Phase 5 brief is built, tested against real Postgres and checked in a real browser. Two pieces depend on credentials from earlier phases and are reported as such. **AI summaries** are built behind a provider interface and tested with a test double, but no summary has been generated against the real Gateway (`AI_GATEWAY_API_KEY` unset); the page says so instead of offering the button. **Stored transcripts** can only arise from live voice sessions, which are still BLOCKED (Phase 3); the storage path is tested end to end through the real end-session route.

### What was built

- **Outcome classification** (`src/server/conversations/outcome.ts`): every finished session gets one outcome, decided from recorded facts only, in this order: FAILED → NOT_CONNECTED (no provider token) → LEAD_CAPTURED → ABANDONED (closed by the sweeper) → SHORT (< 15 s billed) → ENGAGED. Set when the session settles, upgraded when a lead arrives after the call, set to FAILED on a token failure. Lead recording now takes a row lock, which closes a race with settlement and makes the 3-leads-per-session cap atomic. The migration backfills existing sessions with the same rules.
- **Permitted transcripts**: off by default. When an owner turns them on, the widget's consent notice changes and shows an **unticked** checkbox ("Let {business} keep a text transcript … for N days"). A transcript is accepted only if the visitor ticked it when the session was prepared (`Conversation.transcriptConsent`), storage is still on, the session really connected, and it arrives within 10 minutes of the end. It is write-once. The widget sends it with the end report (and in the page-close beacon, trimmed to fit). It is labelled in the dashboard as reported by the caller's browser, not verified against the provider.
- **Summaries** (`src/server/conversations/summaries.ts`): on request (Agent Manager and above, 10 per organization per minute), through the Gateway (`anthropic/claude-haiku-4.5`, unverified). The transcript is passed as delimited data with an instruction to ignore instructions inside it; the output is shown as plain text and labelled AI-generated. Stored with the transcript and deleted with it.
- **Conversation history** (`/dashboard/[orgSlug]/conversations` and `/conversations/[id]`): filters (period, channel, outcome, agent), keyset pagination, billed time from the ledger, and a detail page with metadata, transcript, summary, leads and the server-side event timeline.
- **Analytics** (`/dashboard/[orgSlug]/analytics`, `src/server/analytics/report.ts`): sessions, connected, voice time, average length, leads captured, lead rate, sessions per UTC day (zero-filled, with a table alternative), outcomes, and channel and agent breakdowns. Computed from `Conversation` joined to its `UsageLedgerEntry`, so voice time equals the billable ledger exactly. Lead conversion uses the outcome, so it survives lead deletion.
- **Leads** (`/dashboard/[orgSlug]/leads`): filters, pagination, follow-up status (New, Contacted, Closed; Agent Manager and above), delete (Owner/Admin), links to the conversation.
- **Exports** (`/api/orgs/[orgSlug]/exports/conversations|leads`): CSV with BOM and CRLF line endings, at most 10,000 rows (a header says when the export was cut short), with spreadsheet formula injection neutralised. Conversation exports (metadata only, no transcript or contact data) are open to every member. Lead exports (personal data) are Owner/Admin only. Every export is audit-logged; non-members get 404.
- **Retention controls** (`/dashboard/[orgSlug]/settings`, Owner): transcript storage on/off, transcript retention 1–365 days (default 30), lead retention 30–1095 days (default 365), all enforced by database CHECK constraints too. **Delete all transcripts** needs the typed confirmation "DELETE". **Erase a person's data** (Owner/Admin) deletes leads matched by email or phone (normalised: "+233 24 …", "024 …" and "233…" all match) and transcripts of those conversations or mentioning the email. Its audit entry records counts only.
- **Retention job** (`/api/cron/retention`, daily 03:30 UTC, `CRON_SECRET`): deletes transcripts and leads past each organization's own window, one audit entry per organization; prunes error reports and job runs older than 90 days. Idempotent.
- **Audit logs**: an organization view (`/dashboard/[orgSlug]/audit`, Owner/Admin, filter by area) and a platform view (`/admin/audit`). New audited actions: `privacy.*`, `retention.*`, `export.*`, `lead.deleted`.
- **Admin tools**: `/admin` (every organization with plan, members, agents, 30-day sessions and voice time, and transcript setting; counts only, no customer content), `/admin/monitoring`, `/admin/audit`, plus the existing billing console under one admin layout.
- **Monitoring** (`/admin/monitoring`): database reachability; which credentials are configured (presence only, never values); each scheduled job's last run and last success (flagged if none in 26 hours); 24-hour errors, failed sessions and session errors; stuck sessions; failed knowledge sources; 7-day payment problems and webhook counts; recent failed sessions; and the grouped error list. `GET /api/health` is a public up/down check (no details).
- **Error reporting**: `src/instrumentation.ts` (`onRequestError`) records every uncaught server error in pages, route handlers, server actions and the proxy. `reportError` writes a structured log line and an `ErrorReport` row grouped by fingerprint, with emails, phone numbers, credentials and connection strings scrubbed first. Only the route pattern is recorded, never the request path, headers or cookies. Scheduled jobs record a `JobRun` and report failures. `src/app/error.tsx` shows visitors a generic message with the error's digest as a support reference.

### Acceptance criteria (from the master build prompt) — status

| Criterion | Status |
|---|---|
| Analytics reflect real events | **Met.** Tests drive real sessions through the session service (prepare → token → end → lead) and check every figure, including that voice time equals the ledger sum and that days bucket by UTC across midnight. |
| Access is authorized | **Met.** Every query is scoped to the caller's organization, resolved from their membership. Tested: cross-tenant detail, transcript deletion, lead changes, summaries, exports and pagination cursors; role rules for each action; owner/admin-only audit and lead export; 404 for non-members and non-admins. |
| Retention and deletion behavior is tested | **Met.** Tested: per-organization windows (older deleted, newer kept, other tenants untouched), one audit entry per organization, idempotent re-runs, monitoring pruning, erasure across phone formats and email case (scoped, literal matching), deleting one or all transcripts, deleting a lead, and analytics surviving deletion. |

### Quality gates — actual results

- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 1 warning (the generated `coverage/` folder, as before).
- `npm run test:coverage`: **319 tests in 38 files, all passing.** Statements **85.66%**. New modules: `server/analytics` 97%, `server/privacy` 100%, `server/exports` 96%, `server/conversations` 89%.
- `npm run build`: succeeds; all new pages and routes present.
- Migration `20261022220935_phase5_analytics_privacy`: spurious `DROP INDEX` removed; adds CHECK constraints and the outcome backfill. Applied with `migrate deploy`.
- CI on GitHub: run 39924507852 for commit `3dabe16` — migrations, lint, typecheck, tests and build all green. (Phase 4's commit `e9ad0ed` was green too: run 39826613181.)

### Manual verification (real browser, no AI or Paystack keys)

Sessions can't be held without `AI_GATEWAY_API_KEY`, so 14 sample sessions (with ledger rows, events, 3 leads and 1 transcript) were inserted by SQL into the dev database for a new workspace. The tests above are the proof that figures match real events; this pass checked the pages.

- **Analytics:** 14 sessions, 13 connected, 17.3 min, 3 leads, a 23% lead rate, the daily chart and outcome counts, all matching the inserted rows.
- **Conversations:** the "Lead captured" filter showed exactly 3 rows. The detail page showed the transcript with "deleted automatically on 21 Nov 2026", the summary BLOCKED notice, the lead and the timeline.
- **Data & privacy:**
  - Saved transcripts on with 14 and 180 days.
  - Erasing by "024 123 4567" removed the lead stored as "+233 24 123 4567" plus its transcript.
  - The audit log shows both actions, the erasure with counts only.
- **Widget and leads:**
  - The agent's test widget then showed the 14-day consent text and an unticked checkbox.
  - The leads page listed the remaining 2 leads.
- **Exports:**
  - The lead CSV downloaded with the formula-looking name exported as `'=1+1 …`.
  - The conversation CSV had 14 rows and no contact data.
  - Exporting for another organization returned 404.
- **Platform admin:** after the SQL grant, `/admin` listed the organization with counts, and `/admin/monitoring` showed the database up, the three missing credentials, both jobs never run, and the failed session.
- **Over HTTP:**
  - `/api/health` → `{"status":"ok"}`.
  - `/api/cron/retention` without `CRON_SECRET` → 503.
  - A signed-out export → 401.
- **Not observed live:** `onRequestError` (no real server error occurred during the session; `reportError` itself is tested).
- **Dev-only incident:** the dev server got into a reload loop (recompiling about every 250 ms) after the build cache in `.next/` went stale while the schema and route types were regenerated under a running server. Deleting `.next/` fixed it; nothing in the app code was involved (confirmed by moving the new instrumentation and error files aside, which didn't help). Stop `npm run dev` before `npm run build` or `next typegen`.

### Security controls implemented (new this phase)

- **Tenant scoping and roles:**
  - Every query is scoped by the caller's `organizationId`.
  - Keyset cursors are positions only.
  - Roles per action: Analysts are read-only; transcript and lead deletion and lead export are Owner/Admin; settings and delete-all are Owner only.
- **Transcripts:** explicit visitor opt-in (unticked by default), re-checked server-side, write-once, a 10-minute window, a 128 KB body limit, schema validation, and a malformed transcript never blocks the end report.
- **Exports:** formula-injection-safe and row-capped.
- **Audit and erasure:** retention and erasure are audit-logged without contact details.
- **Error reporting:**
  - Error text is scrubbed of personal data and secrets before logging or storage.
  - The error page shows no internals.
  - Monitoring shows configuration presence, never values.
- **Summaries:** the transcript is passed as delimited data, the output is rendered as plain text, and requests are rate-limited.

Full detail in `docs/SECURITY_MODEL.md`.

### Required environment variables

None new. `CRON_SECRET` now protects both cron routes; `AI_GATEWAY_API_KEY` also unlocks summaries.

### External accounts/credentials still needed

- `AI_GATEWAY_API_KEY`: live voice (and so real transcripts), embeddings, and summaries (check that `anthropic/claude-haiku-4.5` is available on the account).
- `PAYSTACK_SECRET_KEY` and a Paystack account (Phase 4).
- An error-tracking service (e.g. Sentry) and an alerting channel if monitoring should page someone. Not required by the brief; nothing is wired.

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` → "Phase 5 — analytics and data controls". The most important:
- **Transcripts:** they come from the visitor's browser (unverified) and currently hold the agent's speech only.
- **Summaries:** none has been generated live, and their model cost is not metered.
- **Alerting:** monitoring is a page, with no alerts.
- **Workspace deletion:** deleting a whole workspace is still a manual support task.

### Manual steps for the developer

1. `npx prisma migrate deploy`.
2. Make sure `CRON_SECRET` is set in Vercel; `vercel.json` now schedules `/api/cron/sweep-sessions` (03:00 UTC) and `/api/cron/retention` (03:30 UTC).
3. Point an uptime monitor at `GET /api/health`.
4. With `AI_GATEWAY_API_KEY` set: turn transcripts on in Data & privacy, hold a test call with the box ticked, confirm the transcript appears on the conversation page, then click Summarise.

### Phase 6 acceptance criteria (for reference, not yet attempted)

A configured test number completes an end-to-end call where supported, events are idempotent, and usage reconciliation is documented.

## Phase 6 — Telephony: BLOCKED (built and tested up to the providers; no live call yet)

Everything in the Phase 6 brief is built, tested against real Postgres with signed provider requests, and checked over real HTTP and in a real browser. What isn't done is the one thing that needs accounts: a real phone call. There is no Twilio account or number and no direct OpenAI key in this environment, and a Ghana (+233) number needs business KYC with Twilio (registration documents and a Ghana address). So the first acceptance criterion is BLOCKED, not met.

### How a call works

- **Carrier: Twilio Programmable Voice.** It owns the number and sends a signed webhook when a call comes in. It enforces the time limit, reports call progress and durations, and carries out transfers.
- **AI: OpenAI Realtime over SIP.** Twilio's TwiML dials `sip:<project>@sip.api.openai.com;transport=tls`, with our conversation id in a custom `X-Sunleon-Conversation` header. OpenAI sends a signed `realtime.call.incoming` webhook. We accept the call server-side with the agent's instructions, voice and tools.
- **Our server only answers HTTP webhooks.** No audio passes through it, which is why it fits serverless hosting.
- **Why not the AI Gateway:** the Gateway has no SIP endpoint, so phone calls need a direct OpenAI key (`docs/DECISIONS.md`).
- **Verified against official sources on 2026-10-23:**
  - OpenAI's realtime-SIP guide and the installed `openai` SDK 7.43.0 types (accept, reject, refer, hangup, the sideband WebSocket, Standard Webhooks signing).
  - Twilio's security, `<Dial>`, `<Sip>` and Call-resource docs, plus the installed `twilio` SDK 6.2.0 types.
  - Twilio's Ghana regulatory and voice guidelines.
  - Twilio's own worked signature example, used as a unit test vector, which passes.

### What was built

- **Inbound calls** (`/api/telephony/twilio/voice`):
  - Organization and agent come only from the number that was called, a row a platform admin assigned.
  - Allowance is reserved under the same per-organization lock as every session. A phone call is capped at 270 seconds (see limitations).
  - The caller hears "You've reached {business}. This call is answered by an AI assistant." before the AI joins.
- **The AI leg** (`/api/telephony/openai`):
  - The OpenAI webhook is verified with the official SDK.
  - The conversation id from the SIP header is claimed once: an active PHONE conversation, not yet accepted, within 2 minutes.
  - The call is then accepted with server-side instructions, so the business's instructions never pass through a caller's device, unlike the browser widget. Any other call is rejected with SIP 603.
  - A sideband WebSocket then greets the caller and runs the tools:
    - `search_knowledge`
    - `save_contact_details` (only if lead capture is on; it can use the calling number with the caller's agreement)
    - `transfer_to_human` (only if a transfer line is set)
    - `opt_out_of_calls`
    - `end_call`
- **Authorized outbound calling** (Phone page → "Call someone back", Agent Manager and above):
  - One call per request; there is no list or bulk dialling.
  - The person must have asked: either the number belongs to a lead with this business, or the staff member ticks "This person asked us to call them", which is recorded in the audit log.
  - The number must not be on the do-not-call list.
  - Outbound must be on for the number, with a published agent.
  - Destinations: Ghana numbers only by default (`TELEPHONY_OUTBOUND_CALLING_CODES` to change), to limit toll fraud.
  - Calls only between 08:00 and 20:00 Ghana time.
  - At most 20 calls an hour per organization, and no repeat call to the same number within 10 minutes.
  - The time-sensitive checks run inside the organization's lock.
  - Answering machines are hung up on (Twilio answering-machine detection).
- **Consent and opt-out:**
  - Every call says it is an AI assistant before the AI speaks, and the AI must confirm it is an AI if asked.
  - Outbound calls say who is calling and why, and offer "press 9 to stop calls from {business}" before the AI joins.
  - People reach the do-not-call list by pressing 9, by asking the AI, or by staff adding them. Removing an entry is Owner-only with a typed confirmation.
  - The list survives erasure and retention on purpose.
  - Phone calls store no audio and no transcript.
- **Transfer and handoff:**
  - `transfer_to_human` replaces the live call's TwiML through Twilio's API with a `<Dial>` to the business's human line, showing the caller's number. The claim is single-use.
  - The AI usage is settled at that moment, with outcome **Transferred to a person**.
  - The transfer result records whether a person answered.
  - If no one answers, the caller hears that the team will get back to them. The call is marked "Transfer not answered — call this person back" on the conversation and Phone pages, and the contact details the AI took before transferring are in Leads.
- **Call lifecycle and idempotency:**
  - Every Twilio webhook (voice, Dial actions, keypad, status) and the OpenAI webhook is logged in `TelephonyWebhookEvent`.
  - A redelivered voice webhook returns the same TwiML without a second reservation.
  - A redelivered OpenAI event, or a second event for an already accepted call, is a no-op and never rejects a live call.
  - Status callbacks are applied under a row lock and only move a call forward: queued → initiated → ringing → in-progress → terminal. A late or duplicated one is ignored and logged.
  - Settlement happens once (the existing ACTIVE → COMPLETED claim), and both ledger rows have unique keys.
  - A Dial action whose signed CallSid doesn't match the conversation in its URL is ignored.
- **Usage metering:**
  - `VOICE_SECONDS` (the customer's allowance) uses Twilio's own measurement of the AI leg (`DialCallDuration`, source `provider_reported`), never more than the reservation.
  - The new `TELEPHONY_SECONDS` metric records the carrier's whole-call seconds as platform cost only.
  - Cost rates can now be set for each stream (browser voice, phone AI, Twilio inbound, Twilio outbound) in `/admin/billing`, and margins include carrier cost.
- **Failure recovery:**
  - Unknown number → "not in service".
  - No plan or minutes, no published agent, or AI not configured → the transfer line if set, otherwise a short apology.
  - AI leg never connects, or OpenAI refuses the accept → the conversation fails unbilled and the caller goes to the transfer line.
  - Lost Dial action → the status callback settles the call on our clock.
  - Lost status callback → the reconciliation job fills in carrier usage from Twilio's records.
  - Never-settled call → the existing sweeper.
  - Carrier refuses an outbound call → the conversation fails and its reservation is freed.
  - Failed transfer → rolled back, so the AI can take a message.
  - Sideband failure → the call continues without tools, and an error is recorded.
- **Usage reconciliation:**
  - A daily `/api/cron/reconcile-telephony` job (04:00 UTC, `CRON_SECRET`) fetches Twilio's Call record for each finished call: duration and price.
  - It fills in carrier usage lost with a callback and reports duration mismatches.
  - `/admin/telephony` shows the 30-day comparison per organization.
  - The procedure, including the monthly close against Twilio and OpenAI invoices, is in **`docs/USAGE_RECONCILIATION.md`**.
- **Dashboard and admin:**
  - The Phone page (all members) has numbers and settings (Owner/Admin), call-back (Agent Manager+), recent calls with masked numbers, and the do-not-call list. It shows a notice when telephony isn't configured.
  - The conversation detail page has a phone panel.
  - "Phone" is a channel in history, analytics and filters.
  - `/admin/telephony` (platform admin) has the provider setup URLs, number registry, release, and the reconciliation report.
  - `/admin/monitoring` shows Twilio, OpenAI SIP and public-URL status, the new job, and 24-hour telephony webhook counts.
- **Privacy:**
  - A caller's number on a call record is contact data. Erasure by phone removes it, and the retention job removes it after the lead retention window.
  - Telephony webhook logs are pruned after 90 days.
  - Audit entries mask phone numbers.

### Acceptance criteria (from the master build prompt) — status

| Criterion | Status |
|---|---|
| A configured test number completes an end-to-end call where supported | **BLOCKED.** No Twilio account or number and no direct OpenAI key exist here. What is proven: the whole call flow through the real webhook routes with signed requests and test doubles at the two provider APIs (19 integration tests); the provider adapters' exact SDK calls (8 contract tests); and, over real HTTP against a production build, a signed inbound call. In that HTTP run, a real accept request reached OpenAI and was refused for the invalid test key, and the call fell back to the transfer line as designed. The live checklist is under "Manual steps". |
| Events are idempotent | **Met.** Tested: a retried voice webhook (one conversation, one reservation); a redelivered OpenAI event and a second event for the same call (accepted once, never rejected); a repeated Dial action (one ledger row); duplicated and late status callbacks ("duplicate" / "ignored", status never moves backwards); a repeated transfer request (one redirect); and reconciliation re-runs. Also seen live over HTTP: a redelivered `completed` callback answered `duplicate`. |
| Usage reconciliation is documented | **Met.** `docs/USAGE_RECONCILIATION.md` covers what each metric measures and where each number comes from, the daily job, how to read the admin report, and the monthly close against provider invoices. The job and report are tested (lost callback recovered, prices stored, mismatches reported, re-runs idempotent, Twilio failure counted). |

### Quality gates — actual results

- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 1 warning (the generated `coverage/` folder, as before).
- `npm run test:coverage`: **400 tests in 42 files, all passing.** Statements **87.8%** overall; `server/telephony` 93.3%, `server/billing` 92.4%.
- New suites:
  - `tests/integration/telephony-calls.test.ts` (19)
  - `tests/integration/telephony-outbound.test.ts` (21)
  - `tests/unit/telephony.test.ts` (33)
  - `tests/unit/telephony-adapters.test.ts` (8)
- Seven existing assertions were updated for intended changes: new zero-valued fields on erasure and retention results, the PHONE channel, and one test that used "PHONE" as its example of an invalid channel.
- `npm run build`: succeeds; the new routes `/api/telephony/twilio/[event]`, `/api/telephony/openai`, `/api/cron/reconcile-telephony`, `/dashboard/[orgSlug]/phone` and `/admin/telephony` are present.
- CI: run 40071726798 for commit `19c28dd` passed every step (migrations, lint, typecheck, tests against pgvector Postgres, build).
- Migration `20261023084127_phase6_telephony`: spurious `DROP INDEX` removed; adds E.164 CHECK constraints on every stored phone number and non-negative duration checks. Applied with `migrate deploy`.

### Manual verification (production build on localhost, test-only credentials)

Run with `next start` and fake Twilio and OpenAI values (an invalid OpenAI key, a locally generated webhook secret):
- **Admin and settings:**
  - `/admin/telephony` showed the provider setup URLs; registering "030 200 0001" stored +233302000001.
  - The Phone page assigned the published agent, saved the transfer line "030 200 0099" as +233302000099, and turned outbound on.
- **A signed inbound call over HTTP** (a local script signing exactly as Twilio and OpenAI do):
  - Forged signature → 403.
  - Voice webhook → the AI disclosure plus a SIP dial with `timeLimit="270"`.
  - OpenAI incoming → our server called OpenAI's real accept endpoint, which refused the invalid key (401), recorded as `accept_failed`.
  - Dial result `failed` → "Please hold while we connect you to a member of the team", dialling the transfer line with the caller's number.
  - Status `completed` → applied; the same callback again → `duplicate`.
  - In the database: the conversation was FAILED and unbilled (no `VOICE_SECONDS` row), 21 carrier seconds were recorded as `TELEPHONY_SECONDS`, the five webhooks were logged, and one grouped error report was created.
- **Browser:**
  - The Phone page listed the call with the number masked (+233 ••• ••• 567) and outcome Failed.
  - "Call now" for the lead at 21:39 UTC was refused: "Calls can only be placed between 08:00 and 20:00 Ghana time."
  - Adding "024 123 4567" to the do-not-call list showed it masked, with source "Added by staff".
  - The conversation page showed the phone panel (incoming from a masked number, line, carrier status, 21s, not billed).
  - `/admin/monitoring` showed the three telephony indicators, the `reconcile-telephony` job and "Telephony webhooks in the last 24 hours: 5 processed".
- **Found and fixed during this pass:**
  - OpenAI's 401 message contains a masked key fragment (`sk-local********-key`), which was stored as-is in the conversation's error message shown to staff. The scrubber now redacts OpenAI-style `sk-…` keys, and every stored telephony provider error goes through it (the test asserts `[redacted-key]`). The browser pass ran on the build from before this fix.
  - The do-not-call "Type REMOVE" field was too narrow for its placeholder and has been widened.
- **Not observed live:** a real phone call, a real SIP accept, the sideband socket with a real call, a real transfer, Twilio answering-machine detection, and a real reconciliation fetch.
- **Dev-only incidents:**
  - The integration suite reset the shared development database midway through the browser pass (a known limitation), so the sample workspace was re-created and the checks repeated.
  - Locally, `next start` needs `AUTH_TRUST_HOST=true` for sign-in (Vercel sets it automatically); this is now in the runbook.

### Security controls implemented (new this phase)

- **Webhook authentication:**
  - Twilio's `X-Twilio-Signature` (official SDK helper) is checked over the configured public URL, never the Host header, and the payload's `AccountSid` must be ours.
  - OpenAI's Standard Webhooks signature is checked by the official SDK, with a 5-minute tolerance.
  - Both happen before anything is read or written. A missing configuration answers 503, never "accept unverified".
- **Tenant scoping:**
  - Organization and agent come from the called number (admin-assigned), the outbound call's own row, or the conversation row; never from the request.
  - Dial actions must carry the call's own signed CallSid.
  - Phone settings, calls, the opt-out list and erasure are scoped to the member's organization (tested).
- **The SIP header is untrusted:** the conversation id is an unguessable UUID, claimed once within a 2-minute window. A stray or replayed INVITE is rejected with 603.
- **Outbound abuse limits:**
  - Role check, request basis (lead or audited confirmation), do-not-call list, Ghana-only destinations by default, calling hours, hourly and per-number limits, one call per request.
  - A carrier time limit on every call.
- **Privacy:**
  - Caller numbers are masked on every page and in audit entries; full numbers stay only on the call record (erasable, retention-limited) and on leads.
  - No audio or phone transcript is stored.
  - Provider error text is scrubbed before it is stored.
- **Tool calls:** arguments from the model are validated like request bodies. Transfer and contact capture are offered only when the business enabled them.

Full detail in `docs/SECURITY_MODEL.md`.

### Required environment variables

All are new and server-side only; see `.env.example`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`: carrier and webhook verification.
- `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` (`whsec_…`), `OPENAI_PROJECT_ID` (`proj_…`): the AI side of calls.
- `TELEPHONY_OUTBOUND_CALLING_CODES` (optional; default `233`).

`NEXTAUTH_URL` must be the public HTTPS origin, because Twilio signatures are checked against it. `CRON_SECRET` now also runs reconciliation.

### External accounts/credentials still needed

- **A Twilio account**, upgraded from trial for outbound calls to unverified numbers. Then:
  - a phone number: a Ghana mobile number needs a business registration certificate, a Ghana address and a letter of authorization (Twilio's Ghana regulatory guidelines). A non-Ghana test number works for a first end-to-end test; set `TELEPHONY_OUTBOUND_CALLING_CODES` to include its country.
  - Twilio's Ghana guidelines say emergency calls aren't supported and outbound caller ID is "not guaranteed" domestically.
- **An OpenAI platform account with Realtime access:** an API key, the project ID, and a project webhook for `realtime.call.incoming` with its signing secret.
- Still outstanding from earlier phases: `AI_GATEWAY_API_KEY` and `PAYSTACK_SECRET_KEY`.

### Known limitations / blockers

See `docs/KNOWN_LIMITATIONS.md` → "Phase 6 — telephony". The most important:
- **No live call yet.**
- **Phone calls are capped at 4½ minutes.** The tool connection runs inside one 300-second function; this can be raised on Vercel Pro.
- **No phone transcripts or summaries.**
- **English prompts only.**
- **No automatic customer credit** when reconciliation shows a sweeper over-charge.

### Manual steps for the developer

1. `npx prisma migrate deploy`.
2. Set the env vars above in Vercel. `NEXTAUTH_URL` must be the public HTTPS URL; the paths used below come from it.
3. Twilio: buy and verify a number. Set its Voice "A call comes in" webhook to `POST https://<host>/api/telephony/twilio/voice` and "Call status changes" to `POST https://<host>/api/telephony/twilio/status`. Both URLs are shown on `/admin/telephony`.
4. OpenAI: create a project webhook for `realtime.call.incoming` pointing to `https://<host>/api/telephony/openai`, and copy its secret into `OPENAI_WEBHOOK_SECRET`.
5. In `/admin/telephony`, register the number for the organization. On its Phone page, choose the agent, a transfer line, and the inbound/outbound switches.
6. **Live checklist** (the BLOCKED criterion):
   - (a) Call the number and hear the disclosure, then the AI.
   - (b) Ask a knowledge question (`search_knowledge`).
   - (c) Leave contact details, then check Leads.
   - (d) Ask for a person: the transfer rings the human line; let it ring out and check "Transfer not answered".
   - (e) Say goodbye and check that the AI hangs up.
   - (f) Check the conversation page: AI time from Twilio, carrier time, outcome.
   - (g) Place a call-back to your own phone during 08:00–20:00 GMT, press 9, and confirm it's on the do-not-call list and that the next attempt is refused.
   - (h) Run `/api/cron/reconcile-telephony` the next day and compare `/admin/telephony` with Twilio's call log.
   - Note any difference in the realtime events (event names or tool-call shapes) from those in `src/server/telephony/sideband.ts`.
7. Enter the phone cost rates in `/admin/billing` once the first invoices arrive (`docs/USAGE_RECONCILIATION.md` §5).

### Phase 7 acceptance criteria (for reference, not yet attempted)

From the roadmap: advanced voice, validated local languages, and integrations. Voice quality and language support may only be advertised after native-speaker validation (Decision 3 of the brief). The exact acceptance wording comes from the master build prompt when Phase 7 starts.
