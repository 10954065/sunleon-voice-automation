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

## 2026-10-18 — No CLAUDE.md, no AI co-authorship trailers in this repository

**Context:** The developer asked that commits to this public repository contain no Claude-specific files and no Claude contribution/co-authorship attribution.

**Decision:** `.gitignore` excludes `CLAUDE.md` and `.claude/` anywhere in the tree. `includeCoAuthoredBy` is already `false` in the local Claude Code settings, so commit messages carry no `Co-Authored-By` trailer.

**Consequences:** No AI-authorship disclosure appears in the repository's git history or files.
