# Testing Strategy — Sunleon Voice

## Status

Describes the Phase 1 test setup actually in place. Coverage numbers in phase reports are real `vitest` output, never estimated or fabricated.

## Test levels

1. **Unit tests** (Vitest) — pure logic with no I/O: password hashing wrapper, Zod validation schemas, RBAC role-check helpers.
2. **Integration tests** (Vitest, against the real local Postgres container) — registration flow, login flow, organization creation, membership role assignment, and the tenant-isolation guarantee (a member of Org A cannot read/write Org B's data).
3. **E2E tests** (Playwright) — **not yet set up in Phase 1.** The first E2E flow worth automating is "register → create org → see empty dashboard," deferred until Phase 2 adds enough UI surface to make E2E coverage worth the setup cost, per YAGNI. Tracked in `docs/KNOWN_LIMITATIONS.md`.

## Running tests

```bash
docker compose up -d        # integration tests need the real database
npx prisma migrate dev
npm run test                # unit + integration
npm run test:coverage       # with coverage report
```

## Coverage target

The project-wide goal is 80% minimum coverage per the global testing rules. Phase 1's actual measured coverage is reported in `docs/PHASE_STATUS.md` and the phase report — read that for the real number rather than assuming the target was hit.

## What Phase 1 tests actually assert

- A user can register with a valid email/password; duplicate email registration is rejected.
- A user can log in with correct credentials; wrong password is rejected; failed attempts are audit-logged.
- Creating an organization makes the creator its `OWNER`.
- A `Membership` with role `ANALYST` cannot perform an `OWNER`/`ADMIN`-only action (e.g., changing another member's role).
- A member of Organization A, given Organization B's slug or id directly, cannot read or mutate Organization B's data.

## CI

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs lint, typecheck, unit+integration tests (against a Postgres service container), and the production build on every push, so "automated checks passing" (required before merge per the global git workflow rules) is actually enforced rather than aspirational.
