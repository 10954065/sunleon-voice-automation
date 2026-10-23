# Testing Strategy — Sunleon Voice

## Status

Describes the test setup actually in place through Phase 5. Coverage numbers in phase reports are real `vitest` output, never estimated or fabricated.

## Test levels

1. **Unit tests** (Vitest) — pure logic with no I/O: password hashing wrapper, Zod validation schemas, RBAC role-check helpers, text chunking, SSRF IP classification, file extraction (txt/md/csv/HTML), local-disk storage.
2. **Integration tests** (Vitest, against the real local Postgres container with pgvector) — registration, login, organization creation, membership roles, tenant isolation, agent create/draft/publish/rollback/archive, knowledge-source actions, the ingestion pipeline (with a deterministic fake embedding provider — never the real one), and tenant-scoped similarity retrieval.
3. **E2E tests** (Playwright) — **not wired into the automated suite/CI yet**, but used manually in this session (via the Playwright MCP tool) to verify both phases' full user flows in a real browser against a real Postgres instance. Formalizing these into the committed test suite is still pending — tracked in `docs/KNOWN_LIMITATIONS.md`.

## Running tests

```bash
docker compose up -d        # integration tests need the real database
npx prisma migrate deploy   # note: the suite resets this same database
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

Phase 3 (the realtime provider is replaced by a clearly-labelled test double at the provider boundary — these tests are not evidence that live voice works):
- Preparing a session refuses to start, creating nothing, when no voice provider is configured; dashboard users get the real blocker, public visitors a generic message with no configuration details.
- Test sessions use the newest draft; embedded sessions only ever use the published version.
- Embed tickets: round trip, wrong agent, expiry, tampered payload, wrong secret and malformed input are all rejected; removing a site from the allowlist revokes outstanding tickets.
- Token issuance is single-use per conversation and only within 2 minutes of preparation; a mint failure marks the conversation FAILED and records an ERROR usage event.
- The real token route, with no credentials configured, fails with 503 and marks the conversation FAILED (honest blocked path, not mocked).
- Knowledge search through a conversation never returns another tenant's content and refuses before a session starts or after it ends.
- Leads require a started session and lead capture enabled on that version, are scoped from the conversation row, and are capped at 3.
- Rate limits: per IP + agent, and a per-agent ceiling that holds even when every request claims a different IP.
- Instruction assembly puts platform rules before business-supplied text and fences knowledge as reference data.
- Embed domain management: owners only, normalized, de-duplicated, audit-logged; URLs and wildcards rejected; agent managers and other orgs refused.

Phase 4 (the payment provider is replaced by a clearly labelled test double at the provider boundary, and webhook payloads are built to Paystack's documented shapes and signed with a test key — these tests are not evidence that a live Paystack account works):
- Entitlements: a subscription grants its plan only before its paid-through date; cancelled, past-due and non-renewing subscriptions keep access to that date; the trial applies once, only to organizations that never subscribed; overage allowance = budget ÷ rate.
- Billing windows: calendar months from the anchor with month-end clamping (Jan 31 → Feb 28/29); on-time renewals keep the anchor, late ones re-anchor.
- Quotas: no plan → refused with nothing created; trial = 10 minutes, one session at a time; reservation capped at 15 minutes and at what's left; refused under 30 seconds; overage budget extends exactly as far as it pays for; earlier periods ignored; public visitors get a generic message.
- Races: 6 parallel prepares against a limit of 2 → exactly 2 succeed; 6 parallel prepares against 20 minutes reserve exactly 900 + 300 seconds.
- Ledger: 5 concurrent ends plus a late beacon → one ledger row and one `SESSION_ENDED`; duplicate idempotency keys rejected by the database; usage attributed to the right organization and agent with isolated summaries; cost snapshot present only when a rate is configured; warning and exhausted alerts raised once per period.
- Sweeper: an abandoned session is closed and charged its reservation once, a later end report adds nothing, a live session is untouched, an unstarted one is closed without charge, and an organization's next prepare sweeps its own sessions.
- Webhooks: no secret → 503 and nothing stored; bad or missing signature → 401 and nothing touched; malformed body → 400; checkout charge activates the right organization; identical redelivery → duplicate; 4 concurrent deliveries → processed once; Paystack's API disagreeing → nothing granted; amount or currency mismatch → `REJECTED`; verification outage → 503 then success on retry; `subscription.create` before `charge.success` → 503 then stored; renewals on time and late; one customer's renewal never touches another organization; past due keeps access until the paid-through date; cancellation can't be revived by later notices; card authorization data never stored.
- Actions: checkout BLOCKED without a key (provider never called); OWNER/ADMIN only; server-chosen amount and reference; trial, private, unlinked and unknown plans refused; provider failure marks the transaction failed; no second renewing subscription; confirmation idempotent and organization-scoped; cancellation owner-only, waits for Paystack's codes, keeps access; overage budget owner-only, validated and audited; agent limit enforced with archived agents excluded.
- Platform admin: organization owners without the flag are refused; plan edits audited; trial plans can't be made public or linked; duplicate codes rejected; manual assignment refused over a renewing Paystack subscription; cost rate stored per second with its source.
- Paystack adapter: request bodies and headers, refusal of non-Paystack checkout links, error envelopes without a `data` field, network failures, and no secret in error messages.
- Routes: webhook status mapping and 413 for oversized bodies; cron route 503 / 401 / 200.

Phase 5 (`tests/integration/conversation-records.test.ts`, `analytics.test.ts`, `privacy-retention.test.ts`, `privacy-actions.test.ts`, `monitoring-admin.test.ts`, `tests/unit/conversation-helpers.test.ts`, `history-validation.test.ts`):
- **Outcomes:**
  - Each outcome is reached through the real session service (prepare → token → end, the sweeper, a failed mint).
  - A lead after the call upgrades the outcome, and a lead during the call counts at settlement.
  - 6 concurrent lead submissions → exactly 3 stored.
- **Transcripts:**
  - Consent is recorded only when storage is on, and storage is refused without consent.
  - They are also refused when the session never connected, after the window, or once the owner turns storage off.
  - They are write-once, empty ones are rejected, and a malformed transcript still lets the session end through the real route.
- **Summaries:** scoped to the organization; BLOCKED message without a key; explained when there's no transcript; Analysts refused; invalid ids and the per-organization cap enforced.
- **Analytics:**
  - Every figure for sessions driven through the real services, with voice time equal to the ledger sum.
  - UTC day bucketing across midnight with zero-filled days.
  - Another organization's sessions are never counted; agent, channel and range filters work.
  - In-progress sessions are counted separately, and lead conversion survives retention deleting the leads.
- **Retention:**
  - Per-organization windows: older rows deleted, newer kept, other tenants untouched.
  - Session records kept; one audit entry per organization with counts; a second run is a no-op.
  - Error reports and job runs are pruned.
- **Erasure:** phone formats normalised; email matched case-insensitively; scoped to one organization; LIKE wildcards literal; nothing happens without a usable email or phone.
- **Actions:**
  - Data settings: Owner-only, range-checked and audited.
  - Transcript deletion: Owner/Admin only and organization-scoped.
  - Delete-all: needs the typed confirmation.
  - Erasure: its audit entry holds counts only.
  - Lead status: Agent Manager and above; lead changes are organization-scoped.
  - Lead deletion: audited by id only.
- **Exports:**
  - Any member gets conversation metadata without transcripts or contact details.
  - Lead export is Owner/Admin only, with formulas neutralised.
  - Other organization → 404; signed out → 401.
- **Monitoring:**
  - Errors are grouped, scrubbed, and reported without throwing.
  - Job runs are recorded for success and failure.
  - Both cron routes answer 503 / 401 / 200 and record their runs.
  - The monitoring snapshot counts are right; the organization list shows counts only.
  - History pagination has no gaps or duplicates, filters work, and a foreign cursor reveals nothing.
  - Detail, leads and audit queries are organization-scoped.
- **Pure helpers:** the outcome precedence, transcript trimming and byte fitting, CSV quoting, the scrubber, fingerprints, URL filter parsing (invalid values ignored), the UTC day range, and the privacy form schemas.

Verified manually in a real browser (Playwright) in Phase 5, with sample sessions inserted by SQL because live voice is BLOCKED (details in `docs/PHASE_STATUS.md`):
- the analytics figures, the outcome filter, the conversation detail page with its transcript and the summary BLOCKED notice
- saving data settings, erasing a contact by a differently formatted phone number, and the audit entries
- the consent checkbox in the test widget
- the lead and conversation CSVs, including formula neutralising and a 404 for another organization
- the platform organizations and monitoring pages

Verified manually in a real browser (Playwright) in Phase 4, without a Paystack key: trial on the Overview and Billing pages, the "Paystack isn't configured" notice, saving an overage budget, `/admin/billing` returning 404 to non-admins and loading after the SQL grant, manual assignment of Growth reflected on the organization's billing page, and the webhook and cron routes answering 503 over HTTP.

Verified manually in a real browser (Playwright) in Phase 3, without credentials: the voice UI, the honest blocker messages, the microphone-permission-denied message, and embed authorization from an allowed host versus a non-allowed host, a direct visit and an unknown agent. The live spoken conversation is BLOCKED on `AI_GATEWAY_API_KEY`.

## CI

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs migrations, lint, typecheck, unit+integration tests (against a `pgvector/pgvector:pg16` service container), and the production build on every push and pull request.

History, stated honestly: the workflow was first pushed in Phase 2 with a plain `postgres:16-alpine` service, which lacks pgvector, so its first runs failed at `CREATE EXTENSION vector`. This wasn't noticed until Phase 3. Fixed by matching the image to `docker-compose.yml`. That exposed a second failure: `tsc` needs the route/layout types (`LayoutProps`) that Next.js generates into `.next/types`, which a fresh checkout doesn't have, so `npm run typecheck` now runs `next typegen` first. First fully green run: 39783255519 (commit `00efb7b`). CI deliberately sets no `PAYSTACK_SECRET_KEY` or `AI_GATEWAY_API_KEY`, so it exercises the BLOCKED paths; tests that need a key set a fake one at the provider boundary. Check the Actions tab for the current state rather than assuming green.
