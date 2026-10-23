# Security Model — Sunleon Voice

## Status

Describes controls implemented through Phase 5, and flags what is explicitly deferred (with the phase that will add it).

## Authentication

- Auth.js (NextAuth v5), Credentials provider: email + password.
- Passwords hashed with bcrypt (cost factor 12) before storage; `passwordHash` never leaves the server, never logged.
- Sessions: Auth.js **JWT strategy** (encrypted, httpOnly session cookie; `session: { strategy: "jwt" }` in `src/server/auth/config.ts`), which Auth.js requires for the Credentials provider. An individual session can't be revoked server-side before it expires. Access to an organization is still revoked immediately when a `Membership` is removed, because every request re-resolves membership from the database. (Corrected in Phase 3; earlier versions of this document wrongly said sessions were database-backed.)
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

- All secrets (database URL, Auth.js secret, `AI_GATEWAY_API_KEY`) are read from server-side environment variables, never hardcoded and never given a `NEXT_PUBLIC_` prefix.
- `.env.example` lists required variable names with no real values. `.gitignore` excludes every `.env*` file except that template (it was accidentally excluded until Phase 3).
- `AI_GATEWAY_API_KEY` is only read in `src/server/**` modules marked `import "server-only"`; the browser receives single-use, 60-second Gateway client secrets instead (see "Real-time voice" below).
- `AUTH_SECRET` also signs embed tickets, with a domain-separation prefix so a ticket signature can never be confused with an Auth.js value.

## Audit logging

- `AuditLog` table records: organization creation, membership invites/role changes, login success/failure, agent and billing changes, and (Phase 5) data settings, transcript and lead deletions, contact erasure, exports and automatic retention deletions. Metadata never includes secrets or full request bodies, and erasure entries record counts only so the log doesn't keep the data being erased.
- Owners and admins see their organization's log (`/dashboard/[orgSlug]/audit`); platform admins see every organization's (`/admin/audit`). The app has no way to edit or delete entries.

## Rate limiting

- **Auth endpoints (login, registration): still not rate-limited.** A real gap, flagged as a blocker before any public launch.
- **Public voice endpoints (Phase 3):** an in-memory per-process limiter (`src/server/voice/rateLimit.ts`) caps embed session preparation at 10/min per IP + agent **and** 30/min per agent regardless of IP, knowledge searches at 20/min per conversation, and lead submissions at 5/min per conversation. Because provider tokens are single-use per conversation, the per-agent preparation ceiling also bounds token mints, and it holds even if `X-Forwarded-For` is spoofed (Vercel overwrites that header; other hosts may not). The limiter resets on restart and isn't shared across instances, so it must be replaced with a durable one before production. Per-organization quotas (Phase 4, below) are the real cost control.

## Billing, quotas and payments (Phase 4)

- **Server-side entitlements.** Every voice session needs allowance to start. Preparing one takes a per-organization Postgres advisory lock, then checks the plan, the simultaneous-session limit and remaining minutes, and reserves at most 15 minutes. Concurrent requests can't race past a limit (tested with parallel requests). `createAgent` checks the agent limit under the same lock. Public visitors only ever see a generic "unavailable" message, never plan state.
- **Bounded spend.** The overage charge can never exceed the owner's approved budget (default 0 = hard stop). The residual risk — a tampered client talking past its cut-off — falls on the platform, not the customer; see `docs/KNOWN_LIMITATIONS.md`.
- **Idempotent metering.** One ledger row per session (unique key), written only by whoever wins an atomic ACTIVE → COMPLETED claim. Client-reported durations are never billed.
- **Webhook authentication.** `/api/webhooks/paystack` is public but acts only on bodies whose `X-Paystack-Signature` (HMAC-SHA512 of the raw body, secret key) matches, compared in constant time. With no secret configured it answers 503 and stores nothing. Bodies over 256 KB are refused.
- **Webhook integrity.** Identical redeliveries are skipped (SHA-256 body key), and each event's effects commit atomically with its record. `charge.success` is re-verified with Paystack's API before anything is granted, and the amount, currency and plan must match our own records, otherwise the payment is `REJECTED` and audit-logged. Tenants are mapped only through references and codes we created, never through payload metadata.
- **Checkout integrity.** The client names a plan code; the server picks the amount, currency, plan and reference. Customers are only ever redirected to HTTPS `paystack.com` hosts.
- **Data minimisation.** Webhook records keep a summary (references, codes, outcome) — never card details or authorization codes. The Paystack `email_token` is stored because cancellation requires it; it isn't a payment credential.
- **Roles.** Checkout and payment confirmation: OWNER/ADMIN. Cancellation and overage budget: OWNER. All billing changes are audit-logged.
- **Platform admin.** `User.isPlatformAdmin` is checked against the database on every request (not the session token), has no grant UI, and non-admins get a 404 for `/admin/*`. Plan edits, cost rates and manual assignments are audit-logged; trial plans can't be made public or linked to Paystack; manual assignment is refused while a Paystack subscription is renewing.
- **Cron.** `/api/cron/sweep-sessions` and (Phase 5) `/api/cron/retention` require `Authorization: Bearer $CRON_SECRET` (constant-time compare, shared helper `src/server/auth/cron.ts`); they answer 503 when unset.
- **Database guards.** CHECK constraints keep usage quantities, budgets, reservations and plan limits non-negative.

## Conversation data, privacy and monitoring (Phase 5)

- **Transcripts are opt-in twice.** The owner turns storage on, then each visitor ticks an unticked box before the call. The server records consent when the session is prepared and re-checks it (and the owner's setting) when the transcript arrives. It also requires a connected session and arrival within 10 minutes of the end. Transcripts are write-once, schema-validated, size-limited (128 KB request, 200 entries of 2,000 characters), and a malformed one never stops the session from ending.
- **Retention and deletion.** Per-organization windows are enforced daily (and by CHECK constraints on the settings). Owners and admins can delete a transcript or a lead. Owners can delete all transcripts (typed confirmation). Owners and admins can erase a person by email or phone, scoped to their organization, with LIKE wildcards treated literally.
- **Roles.**
  - Analysts: read-only.
  - Lead status and summaries: Agent Manager and above.
  - Transcript and lead deletion, erasure, lead export and the audit log: Owner/Admin.
  - Data settings and delete-all: Owner.
  - Every rule is enforced in the server action or route, not just hidden in the UI.
- **Tenant scoping.** History, detail, analytics, exports, leads and audit queries all filter by the membership's `organizationId`. Pagination cursors are positions only; a cursor from another organization reveals nothing (tested). Export URLs answer 404 to non-members.
- **Exports.** Conversation CSVs carry metadata only. Lead CSVs (visitors' contact details) are Owner/Admin only. Cells that a spreadsheet would run as formulas are prefixed with an apostrophe. Every export is audit-logged.
- **Summaries.** The transcript goes to the model as delimited data with an instruction to ignore instructions inside it. The output is rendered as plain text and labelled AI-generated. Requests are rate-limited per organization.
- **Error reporting.** `onRequestError` records the route pattern, never the request path, headers or cookies. Messages and stacks are scrubbed of emails, phone numbers, bearer tokens, API keys and credentialed URLs before they are logged or stored. Visitors see only a generic page with a digest.
- **Platform console.** It shows counts and configuration presence (never secret values or customer content). `/api/health` reports only up or down.

## Transport / storage encryption

- Transport encryption (TLS) is the responsibility of the hosting platform (Vercel) once deployed; local dev runs over plain HTTP on localhost.
- At-rest encryption depends on the eventual managed Postgres provider's defaults (e.g., Neon/Vercel Postgres encrypt at rest by default) — to be confirmed once a provider is actually chosen (see `docs/PROVIDER_INTEGRATIONS.md`).

## SSRF and file-upload safety (Phase 2)

- **Website knowledge sources** are fetched through `src/server/knowledge/ssrf.ts`, which blocks: non-HTTP(S) schemes, non-standard ports, `localhost`, and any address that resolves to a private/reserved/loopback/link-local range — including `169.254.169.254` (the AWS/GCP/Azure cloud metadata endpoint). Every redirect hop is re-validated, not just the initial URL (a safe URL can still redirect to an internal address). This is a defense layer, not an exhaustive IP-range database — see the comment in that file.
- **File uploads** are restricted to an explicit extension allowlist (`pdf`, `docx`, `txt`, `md`, `csv`) and a 10 MB size cap, enforced server-side in `src/server/actions/knowledge.ts` before the file ever reaches the storage adapter or extraction code.
- **Tested:** `tests/unit/ssrf-shape.test.ts` and `tests/unit/ssrf.test.ts` cover the scheme/port/localhost/metadata-IP/private-IP rejection paths without making real network calls.

## Prompt injection (Phase 3)

Since Phase 3, a model consumes knowledge content, so the following mitigations are now in place. They reduce the risk; no prompt-level defense eliminates it.

- **Ordering and precedence.** `src/server/voice/instructions.ts` puts the platform rules first and states they take precedence over the business instructions, the knowledge, tool results and anything the caller says. Business instructions are labelled as coming from the business and unable to override them.
- **Fenced knowledge.** The knowledge summary sits inside `<business_knowledge>` tags, labelled as reference data, with an explicit rule to ignore instructions found inside knowledge or `search_knowledge` results.
- **Only READY knowledge** grounds live sessions.
- **No action tools exist.** The only tool is a read-only, tenant-scoped knowledge search, so a successful injection can change what the agent *says* but cannot make it do anything — no bookings, payments, outbound requests or data writes. The platform rules forbid claiming that any such action succeeded.
- **Tenant isolation holds regardless.** Tool execution derives tenant scope from the conversation row on the server, so injected text can't reach another tenant's knowledge.
- **Tested:** `tests/unit/voice-instructions.test.ts` asserts the rule ordering, the precedence statement, and that injected knowledge text lands inside the fence.
- **Residual risk:** a caller can talk the model off-script within their own session, or (because session config comes from the browser) replace the instructions entirely. Both affect only that caller's conversation and are covered in `docs/KNOWN_LIMITATIONS.md`.

## Real-time voice and the embedded widget (Phase 3)

Threat model in one line: the widget runs in strangers' browsers on third-party sites, so every public endpoint must assume a hostile caller.

- **No long-lived key in the browser.** The server mints a single-use, 60-second Gateway client secret. Our token route additionally allows exactly one issuance per conversation, only within 2 minutes of preparation (atomic `updateMany` on `tokenIssuedAt IS NULL`), so a leaked conversation id can't be replayed for more sessions.
- **Unguessable conversation ids.** Created server-side with `crypto.randomUUID()` and validated as UUIDs on every route. The public tool, lead and end routes derive `organizationId`/`agentId` from the conversation row only; they never read a tenant id from the request.
- **Embed authorization.** The widget page checks the browser-set `Referer` of its own iframe load against `Agent.allowedEmbedDomains` (exact hostname, empty list denies) and only then issues an HMAC-SHA256 ticket (10-minute TTL, bound to agent and host, `timingSafeEqual` verification). The public prepare route requires the ticket and re-checks the allowlist, so removing a site takes effect immediately. Every failure renders one identical "not available" message, so the page never reveals whether an agent exists. Only OWNER/ADMIN can change the allowlist, and each change is audit-logged.
- **Published versions only on the public path.** Embedded sessions always use `Agent.publishedVersion`; drafts are reachable only through the authenticated dashboard test route (AGENT_MANAGER and above).
- **Error hygiene.** Dashboard users see the real blocker ("AI_GATEWAY_API_KEY is not set"); public visitors only ever see "Voice is temporarily unavailable". Both behaviours are tested.
- **Lead capture.** Visitor-submitted form, Zod-validated (at least one contact field, valid email), accepted only for a conversation whose session actually started (token issued) and whose agent version has lead capture enabled, at most 3 per conversation. Rendered in the dashboard as React text (escaped), never as HTML.
- **Embed snippet.** The business name is attribute-escaped; the agent id is a server-generated cuid.
- **Accepted limitations** (details in `docs/KNOWN_LIMITATIONS.md`): instructions are visible to the caller during their own session because the Gateway applies session config from the browser; a non-browser client can forge `Referer`; session duration is capped client-side only; the rate limiter is per-process.
- **Tested:** `tests/integration/voice-session.test.ts` (tenant-isolated search, draft vs published, ticket/allowlist checks, single-use and expiry of token issuance, failure handling) and `tests/integration/voice-routes.test.ts` (auth and role checks, public error hygiene, rate limiting, honest failure with no credentials), plus unit tests for tickets, domains and validation.

## Dependency risk

- `npm audit` currently reports 8 advisories (5 high, 3 moderate): the Phase 1 `eslint-config-next` → `braces` chain (lint-time dev dependency, not shipped to production), plus a new moderate `mammoth` → `argparse` → `sprintf-js` DoS advisory reachable only through `mammoth`'s own CLI tooling, not through its `extractRawText()` API used here. Fixing either requires a breaking downgrade. Tracked in `docs/KNOWN_LIMITATIONS.md` rather than forced immediately.

## Cross-tenant access tests

Automated test coverage for cross-tenant access is part of the Phase 1 test suite (`tests/tenant-isolation.test.ts`), run as part of the quality gates in every phase going forward, per the project's global testing rules.
