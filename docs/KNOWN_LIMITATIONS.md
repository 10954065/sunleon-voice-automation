# Known Limitations — Sunleon Voice

Honest, current list. Updated every phase. Nothing here is advertised as working until it's removed from this list.

## Scope gaps (by design — later phases)

- No custom/cloned voices and no native-language validation (Phase 7).
- **No live human handoff on the website widget.** Phone calls can transfer to a person (Phase 6); browser sessions still hand off through lead capture.

## Phase 3 — real-time voice

- **No live voice conversation has been tested.** `AI_GATEWAY_API_KEY` is unset in this environment. Dashboard users see "Voice is not configured…" and public visitors see a generic "temporarily unavailable" message — both verified in a real browser. Everything up to the provider boundary is built and tested; the spoken conversation itself is **BLOCKED** until a key is configured, and must then be checked against the list in `docs/PHASE_STATUS.md`.
- **Business instructions are visible to callers.** The Gateway realtime model ignores session config at token-mint time, so instructions and the knowledge summary are sent by the caller's browser in its `session-update` event. A technical visitor can read them in devtools. The draft form warns businesses about this. Truly private instructions would need a server-side relay (persistent voice worker), which the Gateway model's current connection modes don't support from the AI SDK — revisit in Phase 8 or when moving to a dedicated voice service.
- **A token holder controls its own session.** The same mechanism means a visitor with a valid session token could send their own `session-update` (different instructions) and use the session for something else. Since Phase 4 this is bounded by the organization's plan: every session needs allowance to start, holds a reservation of at most 15 minutes, and counts against the simultaneous-session limit.
- **Session length is enforced by the widget, not the provider.** The server reserves each session's time (at most 15 minutes, less if the allowance is short) and the widget ends the call there, but the server cannot terminate a provider session it doesn't relay. A tampered client could talk past its cut-off; that time costs the platform, not the customer (billing caps it). A server-side relay would close this — revisit in Phase 8.
- **Usage is measured by our server's clock, not reconciled with the provider.** The ledger records seconds from token issue to end, capped at the session's reservation (the raw measurement is kept on the `SESSION_ENDED` event as `measuredSeconds` when it differs), or the full reservation for abandoned sessions. It has not been reconciled against the Gateway's own usage reporting, which needs live credentials. A visitor who ends a session early (or a tampered client that reports an early end) is billed for less than the provider may charge.
- **Abandoned sessions are charged their full reservation.** When the browser never reports an end, the sweeper (per organization on the next session, and the daily cron) closes the session and charges the whole reservation. That is a conservative over-estimate for the customer, by design, because the real length is unknown.
- **Rate limiting is in-memory and per-process** (`src/server/voice/rateLimit.ts`). It resets on restart and isn't shared across instances, so it is not real protection in a multi-instance deployment. Replace with a durable limiter (e.g. Upstash Redis) before production.
- **Embed authorization trusts the browser-set `Referer`.** It stops other websites from running the widget in real visitors' browsers, but a non-browser client can forge `Referer` and obtain a ticket. Abuse is bounded by the per-process rate limits (30 session preparations per agent per minute) and, since Phase 4, by the organization's plan: a forged ticket can still use up a business's minutes, but never more than its plan and approved overage.
- **No `frame-ancestors` CSP on the widget page yet.** A non-allowed site can still display the iframe; it just shows "not available" and can never start a session. Adding a per-agent `frame-ancestors` header is defense in depth for Phase 8.
- **Embedding requires an exact hostname.** `example.com` does not cover `www.example.com`; each must be listed. No wildcards, by design.
- **Voices are OpenAI's built-in set, unverified through the Gateway and unevaluated for Ghanaian English** (pronunciation, names, places, cedi amounts, code-switching). Decision 3 of the brief requires that evaluation before any quality claim.
- **Caller speech isn't transcribed.** The transcript shows the agent's speech; enabling input transcription needs a provider-specific transcription model to be confirmed in a credentialed session first.
- **Transcripts are stored only with consent (since Phase 5).** Without the owner's setting and the visitor's tick they exist only in the caller's browser during the call. See "Phase 5" below.

## Phase 4 — billing

- **No live Paystack payment has been made.** `PAYSTACK_SECRET_KEY` is unset. Checkout, verification, cancellation and webhook handling are built to Paystack's published API (checked against Paystack's own documentation repository and official plugin) and tested with signed payloads and a test double, but never against a live account. Until then the Billing page says so, the webhook answers 503, and organizations are put on plans manually from `/admin/billing`. Run the checklist in `docs/PHASE_STATUS.md`.
- **Paystack's GHS payment methods and event payloads are unconfirmed for this account.** Event names and field shapes follow Paystack's docs; mobile-money support for subscriptions in GHS must be confirmed in the Paystack dashboard.
- **Prices, allowances and limits are illustrative** (the brief's Starter/Growth figures, plus a 10-minute, 14-day trial and session/agent limits we chose). They are configurable in `/admin/billing` and must not be presented as final until provider costs are measured.
- **No real cost rate is configured.** Cost estimates and margins stay empty ("unknown") until a platform admin enters a rate measured from real Gateway charges. Each ledger row snapshots the rate in force when it was recorded; changing the rate doesn't rewrite history. Rates are in GHS, so a USD-billed provider cost must be converted by whoever enters it.
- **Overage is capped but invoiced manually.** The overage charge for a period is computed and shown (never above the owner's budget), but Paystack subscriptions charge a fixed plan amount, so overage collection is not automated. Overage is also off on every seeded plan until real costs are known.
- **No proration or in-place plan change.** To switch plans an owner cancels (access runs to the end of the paid month) and then subscribes to the new plan, which starts a fresh period immediately. Admins can reassign plans manually.
- **Failed renewals aren't retried by Paystack** (per their docs). The subscription goes `PAST_DUE`, access continues to the paid-through date, then voice stops until the owner pays again (a fresh checkout).
- **Usage alerts are in-app only** (Overview and Billing banners). No email or SMS — no messaging provider yet.
- **Concurrency and allowance checks serialise per organization** with a Postgres advisory lock held for a few milliseconds. Fine at pilot scale; very high per-organization session rates would queue.
- **Platform admin is granted with SQL.** By design there is no UI to make someone a platform admin; see `docs/DEPLOYMENT_RUNBOOK.md`.
- **The daily cron is a backstop.** Vercel Hobby crons run at most daily; abandoned sessions in an organization are also swept whenever it next starts a session, so allowance isn't held long in practice.

## Phase 5 — analytics and data controls

- **Transcripts come from the visitor's browser and aren't verified.** There is no server-side relay, so the stored text is whatever the widget sent at the end of the call. A tampered client could store made-up text for its own session. That is bounded: the visitor must have consented, it is write-once, it must arrive within 10 minutes of the end, and size is limited. The dashboard labels transcripts accordingly.
- **Transcripts currently hold the agent's speech only.** Caller speech isn't transcribed (Phase 3 limitation), so the "Caller" lines will usually be missing until input transcription is enabled with live credentials.
- **No transcript has been captured from a live call**, because live voice is still BLOCKED on `AI_GATEWAY_API_KEY`. The path is tested through the real end-session route with a test double at the provider.
- **No AI summary has been generated live.** Summaries run through the Gateway with `anthropic/claude-haiku-4.5`, which is unverified on this account. Their model cost is not recorded in the usage ledger or the cost report. The 10-per-minute limit is per server process.
- **Outcomes are rule-based and coarse.** They record what happened (connected, length, lead, failure), not whether the caller's question was resolved. A lead deleted later still leaves its session marked "Lead captured", by design, so analytics stay stable.
- **Analytics are computed on request** from the session and ledger tables, by UTC day and by session start time (a call that crosses midnight counts on its start day). Fine at pilot scale; large tenants will need pre-aggregation. Dashboard test calls are included unless filtered out.
- **Retention runs once a day**, so data can outlive its window by up to a day. Once database backups exist, deleted data stays in them until they expire; backup retention must be set to match (Phase 8). Session records, the usage ledger and the audit log have no expiry. They hold no visitor contact details or transcript text, but the audit log names members.
- **Erasure finds what it can match.** It finds leads by email or phone, and transcripts by the leads' conversations or by the email appearing in the text. A phone number or name spoken in a transcript isn't found; delete such transcripts individually.
- **Deleting a whole workspace or user account isn't self-serve.** It needs a support task, which must also cancel any Paystack subscription. Deleting an organization row cascades to its billing records, so this must not be done casually.
- **Exports are capped** at 10,000 rows per file over preset periods (up to 365 days), and are built in memory rather than streamed.
- **Monitoring is a page, not an alerting system.** There is no external error tracker (e.g. Sentry) and nothing pages anyone. Browser-side errors aren't reported, only server errors. `onRequestError` hasn't yet been seen handling a real server error (the reporter itself is tested).
- **The audit log is append-only by convention**: the app never edits or deletes entries, but it isn't cryptographically tamper-evident and database administrators can change it.

## Phase 6 — telephony

- **No live phone call has been made.** Twilio, OpenAI Realtime SIP and the sideband socket are built from their official documentation and SDK types and tested with test doubles at the API boundary. The realtime event names the sideband relies on (`response.function_call_arguments.done`, `conversation.item.create` with `function_call_output`, `response.create`) come from the SDK's types, not from a live session. One real request reached OpenAI's accept endpoint, refused for a test key.
- **Phone calls are capped at 270 seconds (4½ minutes).**
  - The AI's tool connection runs in `after()` inside the OpenAI webhook's function, which Vercel stops at `maxDuration` (300 s on every plan).
  - Twilio's Dial `timeLimit` ends the AI leg at the reservation.
  - On Vercel Pro both can be raised together: `maxDuration` up to 800 in `src/app/api/telephony/openai/route.ts`, and `MAX_PHONE_SESSION_SECONDS` in `src/server/telephony/config.ts`, keeping the 20-second margin the unit test checks.
  - A separate long-running worker would remove the cap.
- **If the tool connection drops, the call carries on without tools.** Audio is between Twilio and OpenAI, so the caller can keep talking, but knowledge search, contact capture, transfer and hang-up stop working; an error is recorded.
- **No phone transcripts, summaries or recordings.** Spoken transcript consent wasn't built, so phone conversations store none.
- **English only.** The disclosure, the opt-out prompt and the fallback messages are fixed English text (Twilio `<Say>`, en-GB voice). The AI replies in the caller's language when the agent allows it.
- **Outbound calls are one at a time,** placed by staff. There is no campaign or list dialling, by design. The basis for the call (a lead, or a staff confirmation) is recorded, but the person's original request isn't verified.
- **Calling hours are fixed** at 08:00–20:00 UTC (Ghana time). A business calling other time zones would need per-number hours.
- **Ghana numbers aren't self-serve.** A platform admin registers numbers bought in Twilio; Ghana numbers need business KYC there.
- **Twilio caller ID:** its Ghana guidelines say domestic outbound caller ID is "not guaranteed", and emergency calls aren't supported on Twilio numbers. The transfer shows the caller's number, which Twilio allows for forwarded inbound calls, unverified here.
- **Transfer ends the AI's part of the call.** There is no warm transfer or whisper to the human, and no hold music. Only one transfer line per number.
- **Reconciliation doesn't correct customer charges automatically.**
  - A call charged its full reservation by the sweeper (both Twilio callbacks lost) stays charged until an operator issues a manual credit; the report shows it.
  - Mismatches are listed only from the latest run.
  - The job looks back 7 days at up to 200 calls a run.
- **Phone cost rates are unset** until real Twilio and OpenAI invoices exist, so phone margins show as unpriced.
- **The outbound hourly limit counts in the database**, so it is accurate across servers. The 10-per-minute summary limit and the voice route limits from earlier phases are still per process.

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
- **Coverage is 87.8% statements (400 tests), above the 80% target**, but uneven: the Auth.js wrappers (`src/server/auth/config.ts`, `session.ts`, `sign-in.ts`), the real-network branches of the SSRF-safe fetcher and the PDF/DOCX extraction branches remain largely untested. The coverage scope is `src/lib/**` and `src/server/**`, so route handlers and React components are exercised but not counted.
- **Next.js dev tooling auto-generates `AGENTS.md`.** This is Next.js 16's own file, not an AI-attribution artifact.

## Things this document explicitly does not claim

- No claim that a live voice conversation works yet.
- No claim that a live Paystack payment, renewal or cancellation works yet.
- No claim that AI conversation summaries, or transcripts from live calls, work yet.
- No claim that the illustrative prices are profitable — margins are unknown until real costs are entered.
- No claim of Ghanaian-language support (Twi, Ga, Ewe, etc.) or of Ghanaian-English voice quality.
- No claim that a live phone call works yet, or that Ghanaian (+233) numbers are available to a given business (Twilio requires business KYC).
- No claim of SOC2/ISO or any other certification.
- No customer testimonials, usage metrics, or case studies exist anywhere — none have been fabricated.
