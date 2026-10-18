# Architecture — Sunleon Voice

## Status

This reflects the architecture as implemented through **Phase 1**. Components marked "(planned)" do not exist yet.

## High-level shape

```
┌─────────────────────────────────────────────────────────┐
│ Next.js App Router (TypeScript, strict)                  │
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐ │
│  │ Marketing /   │   │ Auth routes  │   │ Dashboard      │ │
│  │ public pages  │   │ (Auth.js)    │   │ (protected,    │ │
│  │               │   │              │   │ tenant-scoped) │ │
│  └──────────────┘   └──────┬───────┘   └───────┬───────┘ │
│                             │                    │         │
│                      ┌──────▼────────────────────▼──────┐ │
│                      │ Server-side tenant/RBAC guard     │ │
│                      │ (src/server/auth/*)               │ │
│                      └──────────────┬────────────────────┘ │
│                                     │                        │
│                      ┌──────────────▼────────────────────┐  │
│                      │ Prisma Client                      │  │
│                      └──────────────┬────────────────────┘  │
└─────────────────────────────────────┼───────────────────────┘
                                       │
                              ┌────────▼─────────┐
                              │ PostgreSQL        │
                              │ (local: Docker;   │
                              │ prod: provider TBD)│
                              └───────────────────┘
```

Planned, not yet built: pgvector-backed knowledge retrieval (Phase 2), real-time voice provider adapter + WebRTC widget (Phase 3), background job runner, Redis, S3-compatible storage, payment provider adapter (Phase 4), telephony adapters (Phase 6).

## Why Next.js App Router

Chosen because (a) the spec prefers it, (b) the target deploy platform is Vercel (Next.js-native), (c) Server Components let tenant-scoped data fetching happen server-side by default, reducing the chance of leaking cross-tenant data to the client. See `docs/DECISIONS.md`.

## Directory layout (Phase 1)

```
src/
  app/
    (marketing)/          # public landing page, no auth required
    (auth)/                # sign-in, sign-up
    (dashboard)/           # protected, tenant-scoped app shell
    api/auth/[...nextauth]/ # Auth.js route handler
  server/
    auth/                  # Auth.js config, RBAC + tenant-context helpers
    db/                    # Prisma client singleton
  lib/                     # shared utilities (validation schemas, etc.)
  components/              # UI components (shadcn/ui-based)
prisma/
  schema.prisma
  migrations/
docs/                      # this documentation set
```

## Request flow for a protected dashboard route

1. Request hits a route under `src/app/(dashboard)/*`.
2. A server-side `getCurrentUser()` helper reads the Auth.js session (server-side only — never trusts a client-supplied user or org id).
3. A `requireOrgContext(orgSlug)` helper loads the caller's `Membership` row for that organization from the database and resolves their role. If no membership exists, the request is rejected (403), not redirected to a generic error that could leak existence of the org.
4. Role checks (`requireRole([...])`) gate specific actions.
5. All Prisma queries for tenant-owned data include `organizationId` in the `where` clause, sourced from the resolved membership — never from a query param or client header.

## Multi-tenancy strategy

Row-level scoping via an `organizationId` foreign key on every tenant-owned table, enforced in application code through shared query helpers rather than Postgres Row-Level Security. See `docs/DATABASE_DESIGN.md` for the reasoning and `docs/SECURITY_MODEL.md` for how this is tested.

## Deployment target

Vercel for the Next.js app (planned — no project has been linked yet in this session). Database: local Docker Postgres for development now; a managed Postgres provider (e.g., Neon or Vercel Postgres via the Vercel Marketplace) is required before any production deployment. This is a known blocker — see `docs/KNOWN_LIMITATIONS.md`.
