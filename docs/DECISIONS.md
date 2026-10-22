# Architectural Decisions Log

Append-only log of significant decisions. Each entry: date, decision, context, alternatives considered, consequences.

## 2026-10-18 — Repository initialized as greenfield project

**Context:** The working directory was empty when this engagement started. No prior architecture, dependencies, or data existed to audit or preserve.

**Decision:** Build Sunleon Voice from scratch following the phased plan in `docs/IMPLEMENTATION_ROADMAP.md`, starting with Phase 0 (audit/docs) and Phase 1 (foundation).

**Alternatives considered:** None — there was no existing codebase to evaluate.

**Consequences:** All architecture choices below are first-time decisions, not migrations.

---

## 2026-10-18 — Stack: Next.js App Router + TypeScript + Tailwind + shadcn/ui

**Context:** Part D of the build spec prefers this stack "where appropriate." No existing app to constrain the choice.

**Decision:** Use Next.js (App Router, TypeScript strict mode), Tailwind CSS, and shadcn/ui components for the web app.

**Alternatives considered:** Remix, SvelteKit — rejected because the spec explicitly prefers Next.js and the target deployment platform (Vercel) is Next.js-native.

**Consequences:** Server Components by default; client components only where interactivity (voice widget, forms) requires it.

---

## 2026-10-18 — Database: PostgreSQL via Prisma, local dev via Docker

**Context:** Spec requires PostgreSQL + Prisma + pgvector (pgvector lands in Phase 2 with knowledge embeddings). Docker is available in this environment; no managed Postgres (Neon/Vercel Postgres) has been provisioned yet.

**Decision:** Use `postgresql` as the Prisma provider from day one (not SQLite), and run a local Postgres container via `docker-compose` for development and test runs, to keep local behavior representative of production.

**Alternatives considered:** SQLite for quick local iteration — rejected because Prisma's SQLite and Postgres providers diverge on enums, UUID generation, and array/vector types, which would force a schema rewrite later. Testcontainers — deferred as unnecessary complexity until the test suite needs per-test database isolation at scale.

**Consequences:** Contributors need Docker (or a real `DATABASE_URL`) to run migrations and the dev server. This is documented in `docs/DEPLOYMENT_RUNBOOK.md` and the root `README.md`.

---

## 2026-10-18 — Authentication: Auth.js (NextAuth v5) with Credentials provider, not Clerk

**Context:** The Vercel environment surfaces Clerk as the native Vercel Marketplace auth integration. However, Clerk requires provisioning an external account and API keys before any auth flow can be built or tested, which would block Phase 1 entirely until those credentials exist.

**Decision:** Build Phase 1 authentication on Auth.js (NextAuth v5) with a Credentials provider (email + bcrypt-hashed password) and the Prisma adapter, so registration, login, and session handling are fully self-contained and testable without external accounts. OAuth providers (Google, etc.) can be added later as additional Auth.js providers without changing the session/RBAC model.

**Alternatives considered:** Clerk — rejected for Phase 1 only, due to the external-credential blocker; worth reconsidering later for its built-in Organizations/RBAC primitives. Supabase Auth — rejected to avoid taking a dependency on Supabase before a database provider is chosen.

**Consequences:** Password hashing, session security, and RBAC enforcement are the project's own responsibility rather than delegated to a vendor. This is called out explicitly in `docs/SECURITY_MODEL.md`.

---

## 2026-10-18 — pgvector column/index managed by raw SQL, not Prisma's schema

**Context:** Phase 2 needs a `vector(1536)` column on `KnowledgeChunk` plus an HNSW cosine-distance index for similarity search. Prisma's classic `schema.prisma` generator (what this project uses — see the Prisma 7 decision above) has no native vector column type, and even the `Unsupported("vector(1536)")` escape hatch only covers the *column*, not a custom-opclass index like `USING hnsw (embedding vector_cosine_ops)`.

**Decision:** The `vector` extension, the `embedding` column, and its HNSW index are all created by hand-written raw SQL inside a dedicated migration (`prisma/migrations/..._phase2_pgvector_embedding/migration.sql`). The column is declared in `schema.prisma` as `embedding Unsupported("vector(1536)")?` so Prisma Migrate's drift detection knows the column exists (and won't try to drop it) — but the index has no equivalent declaration available, so it will always look like "drift" to `prisma migrate dev`.

**Operational rule (must follow):** Never run bare `npx prisma migrate dev` in this project. Always use `npx prisma migrate dev --create-only`, inspect the generated `migration.sql`, and **delete the file without applying it** if it contains `DROP INDEX "KnowledgeChunk_embedding_cosine_idx"` (or drops the `embedding` column) — that is Prisma trying to "fix" something it doesn't understand, not a real required change. This is documented again in `docs/DEPLOYMENT_RUNBOOK.md`.

**Alternatives considered:** Prisma's newer `@prisma/orm-extension-pgvector` "contract-authoring" system (a different, parallel schema model with typed `cosineDistance()` query builders) would solve this cleanly, but it's a ground-up departure from the classic `schema.prisma` + `PrismaClient` model already used throughout this project, and appears to still be an early/evolving surface. Adopting it now would be a disproportionate architecture change for one column. Worth revisiting if this friction becomes a recurring problem.

**Consequences:** Anyone running migrations on this project must read this note first. The main risk is a careless `prisma migrate dev` silently destroying the vector index (data loss for retrieval, not for the underlying chunks/content, which stay intact) during local development.

## 2026-10-18 — No CLAUDE.md, no AI co-authorship trailers in this repository

**Context:** The developer asked that commits to this public repository contain no Claude-specific files and no Claude contribution/co-authorship attribution.

**Decision:** `.gitignore` excludes `CLAUDE.md` and `.claude/` anywhere in the tree. `includeCoAuthoredBy` is already `false` in the local Claude Code settings, so commit messages carry no `Co-Authored-By` trailer.

**Consequences:** No AI-authorship disclosure appears in the repository's git history or files.

---

## 2026-10-19 — Real-time voice through the Vercel AI Gateway, not a direct OpenAI integration

**Context:** Phase 3 needs speech-to-speech conversation in the browser with short-lived credentials. Candidates: OpenAI's Realtime API directly (WebRTC + ephemeral keys), or the AI Gateway's realtime API through the AI SDK.

**Decision:** `openai/gpt-realtime-2` through the AI Gateway (`gateway.experimental_realtime`), with `experimental_useRealtime` from `@ai-sdk/react` in the browser. The API surface was checked against the installed packages' type definitions and compiled source, not only the docs: `onToolCall`/`addToolOutput`, the `RealtimeSetupResponse` shape, single-use 60-second client secrets, and barge-in handling.

**Why:** It reuses the `AI_GATEWAY_API_KEY` the project already depends on (one credential, one bill, one provider adapter pattern). The SDK owns microphone capture, PCM resampling, playback, VAD turn-taking and interruption, which would otherwise be a large amount of hand-written audio code. Swapping the underlying model later is a model-string change.

**Trade-offs accepted:** The API is marked `experimental_`, so pin and re-test on upgrade. The only connection mode is client-secret WebSocket (no WebRTC on this path), and session config cannot be fixed server-side — see the next entry.

## 2026-10-19 — Instructions travel through the caller's browser (accepted, documented limitation)

**Context:** `GatewayRealtimeModel.doCreateClientSecret` deliberately ignores `sessionConfig`; instructions, voice and tools are applied by the browser's `session-update` event. The brief says the embed snippet must not expose "private instructions".

**Decision:** Keep instructions out of the embed snippet and the widget page HTML (verified), and release them only after the embed ticket and allowlist checks pass. Accept that a technical caller can read them during their own session, warn businesses about this in the draft form, and record it in `docs/KNOWN_LIMITATIONS.md`. Real confidentiality needs a server-side relay, which the Gateway model doesn't offer through the AI SDK today; that is a Phase 8 / dedicated-voice-worker question.

## 2026-10-19 — Two-step session flow with single-use token issuance

**Decision:** Step 1 ("prepare": dashboard auth or embed ticket) creates the `Conversation` with a server-generated `randomUUID()` and returns the session config. Step 2 is the URL handed to the hook's `api.token`; it atomically claims `tokenIssuedAt` (only if null and within 2 minutes of preparation), then mints.

**Why:** The hook fetches its own token from a fixed URL, so the conversation must exist before the hook mounts. The id is a bearer reference for the tool and lead routes, so it must be unguessable (cuid isn't). Single-use issuance stops a leaked id being replayed to open more provider sessions. Because React Strict Mode mounts effects twice, the widget defers `connect()` with a timer the effect cleanup cancels; otherwise the second mount would hit the single-use guard.

## 2026-10-19 — Embedding via iframe, authorized by Referer plus a signed ticket

**Context:** Requests made from inside an iframe carry the *widget's* origin, not the embedding site's, so an `Origin` allowlist on the API cannot tell which site embedded the widget.

**Decision:** The widget is an iframe page (`/widget/[agentId]`) served from our domain, which also isolates it from the host page's CSS and scripts. On that page load, the browser sets `Referer` to the embedding page — something the embedding page cannot forge. If its hostname exactly matches the agent's allowlist (an empty list denies), the page issues an HMAC-signed ticket (`AUTH_SECRET`, 10-minute TTL, bound to agent and host). The public prepare route requires the ticket and re-checks the allowlist.

**Limits:** This stops other websites from using the widget in real visitors' browsers; it does not stop a non-browser client from forging `Referer`. Rate limits and Phase 4 quotas are the controls for direct abuse. Embedders must not set `referrerpolicy="no-referrer"` (the UI says so).

## 2026-10-19 — Lead capture is a visitor-submitted form, not a model tool

**Decision:** Contact details are submitted by the visitor through a form in the widget. The model cannot call a "capture lead" tool.

**Why:** The visitor explicitly chooses what to share (consent), nothing depends on the model deciding correctly when to store personal data, and the server enforces `leadCaptureEnabled` on the version that ran plus a cap of 3 leads per conversation.

## 2026-10-19 — Knowledge grounding: bounded summary plus a search tool

**Decision:** Session instructions include up to 4,000 characters of knowledge from READY sources only, and the model also gets a `search_knowledge` tool. The browser executes the tool against `/api/voice/tools/search-knowledge`, which derives tenant scope solely from the conversation row.

**Why:** The summary works with no extra round trip and covers small knowledge bases; the tool covers anything larger. Knowledge from FAILED or half-processed sources never grounds a live answer.

## 2026-10-19 — Apply migrations with `migrate deploy`; never answer `migrate dev`'s prompt

**Context:** After applying, bare `prisma migrate dev` re-diffs, sees the pgvector index "drift" again, and asks for a new migration name. In a non-interactive shell that prompt never returns, and the orphaned processes held Postgres's migration advisory lock until they were found and stopped.

**Rule:** Generate with `npx prisma migrate dev --create-only --name <name>`, inspect and strip any `DROP INDEX "KnowledgeChunk_embedding_cosine_idx"`, then apply with `npx prisma migrate deploy`.
