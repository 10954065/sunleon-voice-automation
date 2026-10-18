# Security Model — Sunleon Voice

## Status

Describes controls implemented in Phase 1, and flags what is explicitly deferred (with the phase that will add it).

## Authentication

- Auth.js (NextAuth v5), Credentials provider: email + password.
- Passwords hashed with bcrypt (cost factor 12) before storage; `passwordHash` never leaves the server, never logged.
- Sessions: database-backed sessions via the Prisma adapter (not stateless JWTs) so a session can be revoked server-side.
- **Deferred:** email verification on signup, password reset flow, OAuth providers, MFA. See `docs/KNOWN_LIMITATIONS.md`.

## Authorization / tenant isolation

- Every protected request resolves the caller's identity from the server-side session — never from a client-supplied header, cookie value, or query parameter claiming a user or org id.
- Organization context is resolved via the caller's `Membership` row for the requested org slug. No membership → 403.
- Role checks (`requireRole([...])`) gate mutating actions. Roles: `SUPER_ADMIN`, `OWNER`, `ADMIN`, `AGENT_MANAGER`, `ANALYST`, matching Part E of the product brief.
- All tenant-owned Prisma queries filter by `organizationId` sourced from the resolved membership. This is enforced through shared helpers (`src/server/auth/tenant.ts`) rather than left to each call site to remember.
- **Tested:** `tests/tenant-isolation.test.ts` asserts that a member of Org A cannot read or mutate Org B's data even when supplying Org B's slug/id directly.

## Input validation

- All form/API inputs validated with Zod schemas at the boundary (`src/lib/validation/*`) before touching the database or business logic. Invalid input is rejected with a 4xx and a field-level error, never silently coerced.

## Secrets management

- All secrets (database URL, Auth.js secret) read from environment variables, never hardcoded.
- `.env.example` lists required variable names with no real values.
- No provider API keys exist yet in Phase 1 (no AI, payment, or telephony providers are integrated), so there is nothing provider-specific to leak at this stage.
- `.gitignore` excludes `.env*`.

## Audit logging

- `AuditLog` table records: organization creation, membership invites/role changes, login success/failure. Metadata never includes secrets or full request bodies.

## Rate limiting

- **Not implemented in Phase 1.** Auth endpoints (login, registration) have no rate limiting yet. This is a real gap, not an oversight — flagged as a blocker to resolve before any public launch. Planned for Phase 1 follow-up or Phase 4 (alongside usage/budget enforcement infrastructure).

## Transport / storage encryption

- Transport encryption (TLS) is the responsibility of the hosting platform (Vercel) once deployed; local dev runs over plain HTTP on localhost.
- At-rest encryption depends on the eventual managed Postgres provider's defaults (e.g., Neon/Vercel Postgres encrypt at rest by default) — to be confirmed once a provider is actually chosen (see `docs/PROVIDER_INTEGRATIONS.md`).

## SSRF and prompt injection

- Not yet applicable: Phase 1 has no website-crawling, file-upload, or LLM-facing features. These protections are required before Phase 2 (knowledge ingestion) and Phase 3 (conversation orchestration) ship, and must be designed in from the start of those phases, not retrofitted.

## Dependency risk

- `npm audit` currently reports 5 high-severity advisories, all transitive through `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` (a lint-time dev dependency, not shipped to production, not reachable by attacker-controlled input). Fixing requires a breaking downgrade of `eslint-config-next`. Tracked in `docs/KNOWN_LIMITATIONS.md` rather than forced immediately, since the fix would trade a dev-tooling CVE for an unknown-risk breaking change at the very start of the project.

## Cross-tenant access tests

Automated test coverage for cross-tenant access is part of the Phase 1 test suite (`tests/tenant-isolation.test.ts`), run as part of the quality gates in every phase going forward, per the project's global testing rules.
