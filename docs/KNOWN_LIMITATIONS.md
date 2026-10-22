# Known Limitations — Sunleon Voice

Honest, current list. Updated every phase. Nothing here is advertised as working until it's removed from this list.

## Scope gaps (by design — later phases)

- No billing, plans, usage allowances, budgets, or payment integration (Phase 4). Phase 3 records usage events but nothing enforces limits yet.
- No conversation analytics dashboard, exports, transcript storage, retention controls, or admin console (Phase 5). Phase 3 shows only the last 10 sessions and 20 leads per agent.
- No telephony (Phase 6).
- No custom/cloned voices and no native-language validation (Phase 7).
- **No configurable live human handoff.** The agent is instructed to offer to connect callers with a person, and lead capture is the hand-off path for now. Live transfer belongs with telephony (Phase 6).

## Phase 3 — real-time voice

- **No live voice conversation has been tested.** `AI_GATEWAY_API_KEY` is unset in this environment. Dashboard users see "Voice is not configured…" and public visitors see a generic "temporarily unavailable" message — both verified in a real browser. Everything up to the provider boundary is built and tested; the spoken conversation itself is **BLOCKED** until a key is configured, and must then be checked against the list in `docs/PHASE_STATUS.md`.
- **Business instructions are visible to callers.** The Gateway realtime model ignores session config at token-mint time, so instructions and the knowledge summary are sent by the caller's browser in its `session-update` event. A technical visitor can read them in devtools. The draft form warns businesses about this. Truly private instructions would need a server-side relay (persistent voice worker), which the Gateway model's current connection modes don't support from the AI SDK — revisit in Phase 8 or when moving to a dedicated voice service.
- **A token holder controls its own session.** The same mechanism means a visitor with a valid session token could send their own `session-update` (different instructions) and use the tenant's provider quota for something else, bounded by the single-use token, the client-side 15-minute cap, and rate limits. Phase 4 quotas and a server-side session duration cap are needed before public launch.
- **Session duration is capped client-side only (15 minutes).** The server cannot terminate a provider session it doesn't relay.
- **Usage is not billing-grade.** `SESSION_ENDED` events record our server's wall-clock duration plus a separately labelled client-reported duration. Neither is authoritative; Phase 4 must reconcile against the Gateway's own usage reporting before charging anyone.
- **Abandoned sessions can stay `ACTIVE`.** If the tab closes and the `pagehide` beacon is lost, the conversation is never ended. A sweeper job (Phase 5 operational controls) should close stale sessions.
- **Rate limiting is in-memory and per-process** (`src/server/voice/rateLimit.ts`). It resets on restart and isn't shared across instances, so it is not real protection in a multi-instance deployment. Replace with a durable limiter (e.g. Upstash Redis) before production.
- **Embed authorization trusts the browser-set `Referer`.** It stops other websites from running the widget in real visitors' browsers, but a non-browser client can forge `Referer` and obtain a ticket. Until Phase 4 quotas exist, direct abuse is bounded only by the per-process rate limits — notably 30 session preparations (and therefore at most 30 provider tokens) per agent per minute.
- **No `frame-ancestors` CSP on the widget page yet.** A non-allowed site can still display the iframe; it just shows "not available" and can never start a session. Adding a per-agent `frame-ancestors` header is defense in depth for Phase 8.
- **Embedding requires an exact hostname.** `example.com` does not cover `www.example.com`; each must be listed. No wildcards, by design.
- **Voices are OpenAI's built-in set, unverified through the Gateway and unevaluated for Ghanaian English** (pronunciation, names, places, cedi amounts, code-switching). Decision 3 of the brief requires that evaluation before any quality claim.
- **Caller speech isn't transcribed.** The transcript shows the agent's speech; enabling input transcription needs a provider-specific transcription model to be confirmed in a credentialed session first.
- **Transcripts are not stored.** They exist only in the caller's browser during the call (the consent notice says so). Storage with retention controls is Phase 5.

## Earlier-phase gaps still open

- **No rate limiting on login/registration.** Must be fixed before any public launch.
- **No email verification or password reset.**
- **No OAuth providers, no MFA.**
- **No automated E2E suite.** Browser flows were verified manually through Playwright in each phase; they are not yet committed as automated tests.
- **No production database, object storage or Vercel project provisioned.** See `docs/DEPLOYMENT_RUNBOOK.md`.
- **Invitation emails are not sent** — no email provider configured.
- **Knowledge ingestion runs synchronously in the request** (no job queue yet), and website sources are a one-time crawl.
- **`prisma migrate dev` has a known false-positive drift** around the hand-managed pgvector index, and its interactive "name the new migration" prompt blocks in non-interactive shells (it left orphaned processes holding the migration lock during Phase 3). Use `--create-only` to generate and `prisma migrate deploy` to apply — see `docs/DECISIONS.md`.
- **Integration tests reset the local development database.** They share the `sunleon_voice` database with `npm run dev`, so running the suite wipes any manual test data. A separate test database is a cheap follow-up.
- **8 npm audit advisories (5 high, 3 moderate)** in dev-only or CLI-only dependency paths (`eslint-config-next` → `braces`; `mammoth` → `argparse` CLI). None is reachable from production code or user input. Phase 3 added `@ai-sdk/gateway` and `@ai-sdk/react` with no new advisories.
- **Test coverage is 77.9% statements, not the 80% target** (158 tests). The new `src/server/voice` module is at 94%. The remaining gap is the same as before: the Auth.js wrappers (`src/server/auth/config.ts`, `session.ts`, `sign-in.ts`), the real-network branches of the SSRF-safe fetcher, and the PDF/DOCX extraction branches. The coverage scope is `src/server/**`, so route handlers and React components are tested but not counted.
- **Next.js dev tooling auto-generates `AGENTS.md`.** This is Next.js 16's own file, not an AI-attribution artifact.

## Things this document explicitly does not claim

- No claim that a live voice conversation works yet.
- No claim of Ghanaian-language support (Twi, Ga, Ewe, etc.) or of Ghanaian-English voice quality.
- No claim of telephony availability in Ghana or anywhere else.
- No claim of SOC2/ISO or any other certification.
- No customer testimonials, usage metrics, or case studies exist anywhere — none have been fabricated.
