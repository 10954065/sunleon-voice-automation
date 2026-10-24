# Architecture — Sunleon Voice

## Status

This reflects the architecture as implemented through **Phase 6**. Components marked "(planned)" do not exist yet.

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

Phase 3 added real-time voice (`src/server/voice/*`, `src/app/api/voice/*`, `src/components/voice-widget/*`, and the public iframe page `src/app/widget/[agentId]`). The browser talks to the model directly over a Gateway WebSocket using a single-use token; our server never relays audio.

```
Business site                    Our app (Next.js)                         Vercel AI Gateway
─────────────                    ─────────────────                         ─────────────────
<iframe src=/widget/:id> ──GET──▶ widget page: Referer ∈ allowlist?
                                   └─ yes → signed embed ticket
widget (in iframe) ──POST prepare {ticket}──▶ verify ticket + allowlist,
                                              create Conversation (UUID),
                                   ◀── {conversationId, sessionConfig}
useRealtime ──POST /sessions/:id/token──▶ claim tokenIssuedAt once (≤2 min),
                                          mint client secret ──────────────▶ getToken (60 s)
                                   ◀── {token, url, tools:[search_knowledge]}
useRealtime ═══════════ WebSocket (ai-gateway-auth.<token>) ══════════════════▶ gpt-realtime-2
  │  session-update {instructions, voice, server VAD, tools}
  │  on tool call ──POST /tools/search-knowledge {conversationId, query}──▶ tenant scope
  │                                                from Conversation row → pgvector
  └─ on end ──POST /sessions/:id/end──▶ COMPLETED + SESSION_ENDED usage event
```

The dashboard "Test voice" panel uses the same widget, with step 1 replaced by an authenticated, role-checked route that tests the latest draft.

**Billing (Phase 4)** wraps that flow. When a session is prepared, `reserveVoiceSeconds` (in `src/server/billing/quota.ts`) runs inside the transaction that creates the conversation. Under a per-organization advisory lock it sweeps abandoned sessions, resolves entitlements (subscription within its paid-through date → the trial → none), and checks the simultaneous-session limit and remaining minutes. It stores the reservation on the conversation, and that becomes the widget's cut-off. Ending a session (or the sweeper) settles it once into `UsageLedgerEntry` and raises at most one warning and one exhausted alert per period. Payments go through the Paystack adapter: checkout (server action) → Paystack → return page verification and/or a signed webhook → `applySuccessfulCharge` → `Subscription`. Platform admins manage plans, cost rates and manual assignments in `/admin/billing`. The cron route `/api/cron/sweep-sessions` is a daily backstop for the sweeper.

**Analytics and data controls (Phase 5)** sit on the same tables. Settling a session also classifies its outcome from recorded facts; a lead recorded later upgrades it, under a row lock that orders the two. When the owner enables transcripts and the visitor ticks the box, the widget sends its transcript with the end report and `storeTranscript` keeps it once. Summaries are generated on request through the Gateway. History, analytics and exports query `Conversation` joined to `UsageLedgerEntry`, always scoped to the caller's organization. A daily, `CRON_SECRET`-protected `/api/cron/retention` deletes transcripts and leads past each organization's window. Both cron jobs record a `JobRun`. `src/instrumentation.ts` sends every uncaught server error to `reportError` (scrubbed log line plus a grouped `ErrorReport`). `/admin` (organizations, monitoring, audit, billing) reads these for platform admins without exposing customer content.

Still planned, not yet built: a background job runner (async ingestion), Redis (durable rate limiting), S3-compatible storage, email notifications (usage alerts are in-app only), and a server-side voice relay for the browser widget if instruction confidentiality or server-enforced session caps become requirements.

**Telephony (Phase 6)** adds a second voice path that needs no media server:
1. Twilio receives the call and posts a signed webhook to `/api/telephony/twilio/voice`.
2. We reserve allowance and create a PHONE conversation and its `PhoneCall`, then answer with TwiML: the AI disclosure, then `<Dial timeLimit><Sip>` to OpenAI's SIP endpoint carrying the conversation id in a custom header.
3. OpenAI posts a signed `realtime.call.incoming` to `/api/telephony/openai`. We claim the conversation once and accept the call with server-side instructions and tools.
4. A sideband WebSocket (in `after()`) runs the tools.
5. Twilio's Dial action and status callbacks settle the conversation (AI seconds from `DialCallDuration`) and record carrier seconds.
6. A daily job reconciles against Twilio's call records.

Audio flows only between Twilio and OpenAI. Outbound calls start from a server action that applies the authorization rules, then `calls.create`.

## Why Next.js App Router

Chosen because (a) the spec prefers it, (b) the target deploy platform is Vercel (Next.js-native), (c) Server Components let tenant-scoped data fetching happen server-side by default, reducing the chance of leaking cross-tenant data to the client. See `docs/DECISIONS.md`.

## Directory layout (Phase 6)

```
src/
  app/
    (marketing)/          # public landing page, no auth required
    (auth)/                # sign-in, sign-up
    dashboard/[orgSlug]/   # protected, tenant-scoped app shell
      agents/              # Agent Studio, knowledge base, voice test/embed/activity UI
      billing/             # plan, usage, overage budget, checkout, cancel, history (Phase 4)
      analytics/ conversations/ leads/ settings/ audit/   # Phase 5: analytics, history, leads, data & privacy, audit log
      phone/               # Phase 6: numbers, call-back, recent calls, do-not-call list
    admin/                 # platform console: organizations, monitoring, audit (Phase 5), billing (Phase 4), telephony (Phase 6)
    widget/[agentId]/      # public iframe page for embedded voice (Phase 3)
    api/auth/[...nextauth]/ # Auth.js route handler
    api/voice/             # session prepare/token/end, search-knowledge tool, leads (Phase 3)
    api/webhooks/paystack/ # signed Paystack webhook receiver (Phase 4)
    api/cron/sweep-sessions/ # CRON_SECRET-protected abandoned-session sweeper (Phase 4)
    api/cron/retention/    # CRON_SECRET-protected daily retention job (Phase 5)
    api/orgs/[orgSlug]/exports/[kind]/ # CSV exports (Phase 5)
    api/health/            # public up/down check (Phase 5)
    api/telephony/twilio/[event]/ # signed Twilio webhooks: voice, Dial actions, keypad, status (Phase 6)
    api/telephony/openai/  # signed OpenAI realtime.call.incoming webhook (Phase 6)
    api/cron/reconcile-telephony/ # CRON_SECRET-protected daily usage reconciliation (Phase 6)
  server/
    auth/
      config.ts            # Auth.js (NextAuth) setup
      session.ts           # session lookup + tenant context — depends on Auth.js
      tenant.ts             # pure Prisma role/membership logic — no Auth.js dependency,
                             # split out specifically so it's unit-testable (see docs/TESTING_STRATEGY.md)
    actions/                # Server Actions (register, org, membership, agent, knowledge)
    knowledge/              # Phase 2 pipeline: chunk, extract, ssrf, embeddings, storage, retrieval, pipeline
    voice/                  # Phase 3: provider, session lifecycle, instructions, embed tickets, domains, rate limit
    billing/                # Phase 4: entitlements, quota, usage ledger, sweeper, paystack, charges, webhooks, report
    conversations/          # Phase 5: outcome rules, transcripts, summaries, history queries
    analytics/ leads/ audit/ exports/ privacy/ admin/   # Phase 5: reports, queries, CSV, retention and erasure, platform overview
    observability/          # Phase 5: error reporting, job runs
    telephony/              # Phase 6: Twilio + OpenAI SIP adapters, TwiML, lifecycle, tools, sideband, outbound, reconciliation
    db/                    # Prisma client singleton
  lib/                     # shared utilities (validation schemas, etc.)
  components/              # UI components (shadcn/ui-based) and voice-widget/ (Phase 3)
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
