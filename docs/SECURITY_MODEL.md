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
- **Tested:** `tests/integration/tenant-isolation.test.ts` asserts that a member of Org A cannot read or mutate Org B's data even when supplying Org B's slug/id directly. Phase 2 extends this: every `Agent`/`KnowledgeSource`/`KnowledgeChunk` query filters by `organizationId` (not just the record's own id), and `tests/integration/knowledge.test.ts` proves a similarity search scoped to Org A never returns Org B's chunks.

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

## SSRF and file-upload safety (Phase 2)

- **Website knowledge sources** are fetched through `src/server/knowledge/ssrf.ts`, which blocks: non-HTTP(S) schemes, non-standard ports, `localhost`, and any address that resolves to a private/reserved/loopback/link-local range — including `169.254.169.254` (the AWS/GCP/Azure cloud metadata endpoint). Every redirect hop is re-validated, not just the initial URL (a safe URL can still redirect to an internal address). This is a defense layer, not an exhaustive IP-range database — see the comment in that file.
- **File uploads** are restricted to an explicit extension allowlist (`pdf`, `docx`, `txt`, `md`, `csv`) and a 10 MB size cap, enforced server-side in `src/server/actions/knowledge.ts` before the file ever reaches the storage adapter or extraction code.
- **Tested:** `tests/unit/ssrf-shape.test.ts` and `tests/unit/ssrf.test.ts` cover the scheme/port/localhost/metadata-IP/private-IP rejection paths without making real network calls.

## Prompt injection (deferred to Phase 3)

- Knowledge content (FAQs, uploaded documents, crawled web pages) is treated as untrusted input per Part E, but no LLM actually consumes it yet — retrieval (`retrieveRelevantChunks`) just returns matching text chunks; nothing is passed to a model. Prompt-injection defenses (instructing the model to treat retrieved content as data, not instructions) must be designed into the conversation orchestration engine when Phase 3 builds it, not retrofitted after.

## Dependency risk

- `npm audit` currently reports 8 advisories (5 high, 3 moderate): the Phase 1 `eslint-config-next` → `braces` chain (lint-time dev dependency, not shipped to production), plus a new moderate `mammoth` → `argparse` → `sprintf-js` DoS advisory reachable only through `mammoth`'s own CLI tooling, not through its `extractRawText()` API used here. Fixing either requires a breaking downgrade. Tracked in `docs/KNOWN_LIMITATIONS.md` rather than forced immediately.

## Cross-tenant access tests

Automated test coverage for cross-tenant access is part of the Phase 1 test suite (`tests/tenant-isolation.test.ts`), run as part of the quality gates in every phase going forward, per the project's global testing rules.
