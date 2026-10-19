# Architecture — Sunleon Voice

## Status

This reflects the architecture as implemented through **Phase 2**. Components marked "(planned)" do not exist yet.

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

Phase 2 added a knowledge pipeline (`src/server/knowledge/*`): extraction → chunking → embedding (Vercel AI Gateway) → pgvector storage, sitting alongside the dashboard/Prisma stack above, with its own SSRF-protected fetcher for website sources and a local-disk storage adapter for uploads (dev-only — see `docs/PROVIDER_INTEGRATIONS.md`).

Still planned, not yet built: real-time voice provider adapter + WebRTC widget (Phase 3), background job runner, Redis, S3-compatible storage, payment provider adapter (Phase 4), telephony adapters (Phase 6).

## Why Next.js App Router

Chosen because (a) the spec prefers it, (b) the target deploy platform is Vercel (Next.js-native), (c) Server Components let tenant-scoped data fetching happen server-side by default, reducing the chance of leaking cross-tenant data to the client. See `docs/DECISIONS.md`.

## Directory layout (Phase 2)

```
src/
  app/
    (marketing)/          # public landing page, no auth required
    (auth)/                # sign-in, sign-up
    dashboard/[orgSlug]/   # protected, tenant-scoped app shell
      agents/              # Agent Studio + knowledge base UI (Phase 2)
    api/auth/[...nextauth]/ # Auth.js route handler
  server/
    auth/
      config.ts            # Auth.js (NextAuth) setup
      session.ts           # session lookup + tenant context — depends on Auth.js
      tenant.ts             # pure Prisma role/membership logic — no Auth.js dependency,
                             # split out specifically so it's unit-testable (see docs/TESTING_STRATEGY.md)
    actions/                # Server Actions (register, org, membership, agent, knowledge)
    knowledge/              # Phase 2 pipeline: chunk, extract, ssrf, embeddings, storage, retrieval, pipeline
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
2. A server-side `getCurrentUser()` helper (`src/server/auth/session.ts`) reads the Auth.js session (server-side only — never trusts a client-supplied user or org id).
3. `requireOrgContext(orgSlug)` (also in `session.ts`) calls the pure `resolveMembership(userId, slug)` function (`src/server/auth/tenant.ts`) to load the caller's `Membership` row for that organization and resolve their role. If no membership exists, the request is rejected (403), not redirected to a generic error that could leak existence of the org.
4. Role checks (`requireRole([...])`) gate specific actions.
5. All Prisma queries for tenant-owned data include `organizationId` in the `where` clause, sourced from the resolved membership — never from a query param or client header.

## Multi-tenancy strategy

Row-level scoping via an `organizationId` foreign key on every tenant-owned table, enforced in application code through shared query helpers rather than Postgres Row-Level Security. See `docs/DATABASE_DESIGN.md` for the reasoning and `docs/SECURITY_MODEL.md` for how this is tested.

## Deployment target

Vercel for the Next.js app (planned — no project has been linked yet in this session). Database: local Docker Postgres for development now; a managed Postgres provider (e.g., Neon or Vercel Postgres via the Vercel Marketplace) is required before any production deployment. This is a known blocker — see `docs/KNOWN_LIMITATIONS.md`.
