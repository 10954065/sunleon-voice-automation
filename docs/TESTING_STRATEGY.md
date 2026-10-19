# Testing Strategy — Sunleon Voice

## Status

Describes the test setup actually in place through Phase 2. Coverage numbers in phase reports are real `vitest` output, never estimated or fabricated.

## Test levels

1. **Unit tests** (Vitest) — pure logic with no I/O: password hashing wrapper, Zod validation schemas, RBAC role-check helpers, text chunking, SSRF IP classification, file extraction (txt/md/csv/HTML), local-disk storage.
2. **Integration tests** (Vitest, against the real local Postgres container with pgvector) — registration, login, organization creation, membership roles, tenant isolation, agent create/draft/publish/rollback/archive, knowledge-source actions, the ingestion pipeline (with a deterministic fake embedding provider — never the real one), and tenant-scoped similarity retrieval.
3. **E2E tests** (Playwright) — **not wired into the automated suite/CI yet**, but used manually in this session (via the Playwright MCP tool) to verify both phases' full user flows in a real browser against a real Postgres instance. Formalizing these into the committed test suite is still pending — tracked in `docs/KNOWN_LIMITATIONS.md`.

## Running tests

```bash
docker compose up -d        # integration tests need the real database
npx prisma migrate dev
npm run test                # unit + integration
npm run test:coverage       # with coverage report
```

## Coverage target

The project-wide goal is 80% minimum coverage per the global testing rules. Phase 1's actual measured coverage is reported in `docs/PHASE_STATUS.md` and the phase report — read that for the real number rather than assuming the target was hit.

## What the tests actually assert

Phase 1:
- A user can register with a valid email/password; duplicate email registration is rejected.
- A user can log in with correct credentials; wrong password is rejected; failed attempts are audit-logged.
- Creating an organization makes the creator its `OWNER`.
- A `Membership` with role `ANALYST` cannot perform an `OWNER`/`ADMIN`-only action (e.g., changing another member's role).
- A member of Organization A, given Organization B's slug or id directly, cannot read or mutate Organization B's data.

Phase 2:
- Creating an agent creates exactly one unpublished draft version; editing the draft updates that same row (no new version) until published.
- Publishing locks the draft (`publishedAt` set) and the next edit creates a fresh draft version — publish history is append-only.
- Rolling back repoints `Agent.publishedVersionId` to an older published version without mutating any version row.
- An `ANALYST` cannot create/edit agents; an `AGENT_MANAGER` cannot roll back a published version (OWNER/ADMIN only).
- A knowledge source for an agent outside the caller's organization is rejected.
- The ingestion pipeline chunks and embeds a source end-to-end (with a fake embedding provider) and marks it `READY`; it marks a source `FAILED` with a real error message when extraction yields no text or when run against the wrong organization id.
- Tenant-scoped similarity search never returns another organization's chunks, even when both exist with similar content.
- SSRF protections reject non-HTTP(S) schemes, non-standard ports, `localhost`, and the cloud metadata IP literal before any network call is attempted.

## CI

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs lint, typecheck, unit+integration tests (against a Postgres service container), and the production build on every push, so "automated checks passing" (required before merge per the global git workflow rules) is actually enforced rather than aspirational.
