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
