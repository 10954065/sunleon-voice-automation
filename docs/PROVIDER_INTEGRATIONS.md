# Provider Integrations — Sunleon Voice

## Status

**Phase 1 had zero external provider dependencies by design.** Phase 2 added an embeddings provider behind an adapter. Phase 3 adds real-time voice through the **same** provider (Vercel AI Gateway) and the same key. No live credential is configured in this environment, so both are implemented and tested up to the provider boundary, and the live calls are BLOCKED.

Phase 4 adds payments through **Paystack**, likewise implemented and tested up to the provider boundary, with live payments BLOCKED on credentials.

Phase 6 adds telephony through **Twilio** (carrier) and **OpenAI Realtime over SIP** (the AI on the call), again built and tested up to both providers, with the live call BLOCKED on credentials.

Everything after Phase 6 is still an **evaluation plan** for later phases, not a claim that those integrations exist or that pricing/capabilities have been verified against current provider documentation. Each will be re-verified against official docs immediately before it is implemented, per Part D: "Use official, current provider documentation... Never invent APIs or assume an account has access to a feature."

## Phase 2 — Knowledge ingestion & retrieval (implemented)

| Need | What's actually used | Notes |
|---|---|---|
| Document parsing | `pdf-parse` (PDF), `mammoth` (DOCX), `csv-parse` (CSV), native `Buffer` read (TXT/MD), `cheerio` (HTML → text for crawled pages) | Real, local, no API key required. Both `pdf-parse` and `mammoth` had breaking API changes versus older assumptions — verified against their actual installed type definitions before use, per `docs/DECISIONS.md`. |
| Website crawling | Node's built-in `fetch`, with hand-written SSRF protections (`src/server/knowledge/ssrf.ts`) | Blocks private/reserved/loopback/link-local IPs (including the 169.254.169.254 cloud metadata address), non-HTTP(S) schemes, non-standard ports, and validates every redirect hop, not just the initial URL. |
| Embeddings | Vercel AI Gateway via the `ai` SDK, plain model string `"openai/text-embedding-3-small"` (1536 dimensions) | **Requires `AI_GATEWAY_API_KEY`, not yet set in this environment.** Without it, `src/server/knowledge/embeddings.ts` throws `MissingEmbeddingCredentialsError` and the knowledge source is marked `FAILED` with that exact message — verified live in a real browser in this session rather than assumed. Get a key at vercel.com; no other code change needed. |
| Vector storage | pgvector extension, `pgvector/pgvector:pg16` Docker image locally | Production needs a managed Postgres provider that supports the `vector` extension (Neon and Vercel Postgres both do) — not yet provisioned. |
| File storage | Local disk (`src/server/knowledge/storage.ts`, `.uploads/`, gitignored) | Explicitly dev-only and documented as such. Must be swapped for an S3-compatible adapter (Vercel Blob / R2 / S3) before production — the `StorageAdapter` interface is already shaped for that swap. |

## Phase 3 — Real-time voice MVP (implemented; live session BLOCKED on credentials)

| Need | What's actually used | Notes |
|---|---|---|
| Speech ⇄ speech model | `openai/gpt-realtime-2` through the **Vercel AI Gateway realtime API** (`gateway.experimental_realtime` from `@ai-sdk/gateway` 4.0.116) | Same `AI_GATEWAY_API_KEY` as Phase 2 embeddings — no second provider account. Chosen over a direct OpenAI integration; see `docs/DECISIONS.md`. |
| Browser client | `experimental_useRealtime` from `@ai-sdk/react` 4.0.147 | Handles microphone capture (24 kHz PCM), playback, server VAD turn-taking, and barge-in (on `speech-started` it stops playback and sends `conversation-item-truncate` — read in the installed SDK source, not assumed). |
| Transport | Client-secret **WebSocket** (`ai-gateway-auth.<token>` subprotocol) | The brief allows "WebRTC when appropriate". The Gateway realtime model only supports client-secret WebSocket, so WebRTC isn't available on this path. |
| Session credential | Single-use Gateway client secret, 60-second expiry, minted server-side by `src/server/voice/provider.ts` | `AI_GATEWAY_API_KEY` never leaves the server. Our own token route also enforces single-use issuance per conversation within a 2-minute window. |
| Voices | OpenAI built-in realtime voices: marin, cedar (recommended), alloy, ash, ballad, coral, echo, sage, shimmer, verse | From OpenAI's realtime API reference (checked 2026-10-19). **Not yet heard through the Gateway** (no credentials), and **none evaluated for Ghanaian English** — Decision 3 of the brief. |
| Knowledge grounding | Bounded summary of READY knowledge in the session instructions, plus a `search_knowledge` realtime tool executed against our tenant-scoped pgvector retrieval | The tool needs embeddings, so the same `AI_GATEWAY_API_KEY`. |

What is verified vs. not, precisely:

- **Verified (tests and a real browser, without credentials):** consent → microphone permission → session preparation → error states; permission-denied message; the honest "Voice is not configured" blocker for dashboard users and the generic "temporarily unavailable" message for public visitors; embed authorization (allowed host shows the widget; a non-allowed host, a direct visit, and an unknown agent all show the same "not available" message); private instructions absent from the widget page HTML; single-use token issuance; tenant-isolated knowledge search; lead capture.
- **Not verified — BLOCKED on `AI_GATEWAY_API_KEY`:** an actual spoken conversation. That covers the Gateway accepting our session config, the voices sounding as named, tool calls arriving and being answered mid-call, interruption behaving well, and usage events (`session-usage`/`session-closed`) arriving. Every one of these must be checked in the first credentialed session; see `docs/PHASE_STATUS.md` for the checklist.

Important constraint found while building: the Gateway realtime model **ignores `sessionConfig` passed at mint time** (comment and code in `@ai-sdk/gateway`'s `GatewayRealtimeModel.doCreateClientSecret`). Instructions, voice and tools are applied by the browser's `session-update` event, so business instructions necessarily pass through the caller's browser. See `docs/SECURITY_MODEL.md` and `docs/DECISIONS.md`.

## Phase 4 — Billing (implemented; live payments BLOCKED on credentials)

**Provider:** Paystack, behind the `PaymentProvider` interface in `src/server/billing/paystack.ts` (checkout, verify transaction, disable subscription). Stripe remains a later option for international billing.

**Verified against Paystack's own published sources on 2026-10-22** (paystack.com blocks automated fetches, so the checks used Paystack's documentation repository and their official Magento plugin on GitHub):
- Webhooks carry `X-Paystack-Signature`: HMAC-SHA512 of the raw request body, keyed with the **secret key** (there is no separate webhook secret). The official plugin compares it in constant time and then re-verifies the transaction with the API — we do both.
- A subscription starts by initializing a transaction with a `plan` code; Paystack then sends `charge.success` and `subscription.create` (carrying `subscription_code`, `email_token`, `next_payment_date`).
- Subscriptions are cancelled with `POST /subscription/disable { code, token }`, where `token` is the `email_token`.
- Failed subscription charges are **not retried** by Paystack.
- The documentation repository is dated 2018. Field names (`charge.success`, `invoice.payment_failed`, `subscription.not_renew`, `subscription.disable`) match the current plugin, but every payload must be re-confirmed in a live test-mode session.

**Not verified (BLOCKED on `PAYSTACK_SECRET_KEY`):** a real checkout, real webhook deliveries, renewal and cancellation on a live account, and which GHS payment methods (card, mobile money) subscriptions support. Run the checklist in `docs/PHASE_STATUS.md`.

**Setup once credentials exist:**
1. Set `PAYSTACK_SECRET_KEY` (test key first).
2. In the Paystack dashboard, create monthly GHS plans with the same amounts as Starter and Growth; paste each `PLN_` code into the plan in `/admin/billing`. A plan without a code can't be bought online.
3. Set the webhook URL to `https://<your-host>/api/webhooks/paystack`. Paystack's documented sending IPs can additionally be allow-listed at the edge; the signature check doesn't depend on it.

## Phase 5 — Summaries and error reporting

**Conversation summaries** use the same Vercel AI Gateway key (`AI_GATEWAY_API_KEY`) through the AI SDK's `generateText`, with the model `anthropic/claude-haiku-4.5`, behind the `ConversationSummarizer` interface in `src/server/conversations/summaries.ts`. **Not verified:** no summary has been generated against the real Gateway, and the model's availability on the account must be checked. Without a key the conversation page says summaries aren't available, and the action returns that message instead of calling anything.

**Error reporting** is in-house for now: structured JSON log lines plus a grouped `ErrorReport` table shown on `/admin/monitoring`. No third-party tracker (e.g. Sentry) or alerting service is integrated. Adding one later means calling it from `reportError`, plus a DSN and a data-processing review.

## Phase 6 — Telephony (implemented; live call BLOCKED on credentials)

| Need | What's used | Notes |
|---|---|---|
| Carrier: numbers, inbound webhooks, outbound calls, status, transfer | **Twilio Programmable Voice**, official `twilio` SDK 6.2.0, behind `TelephonyCarrier` (`src/server/telephony/twilio.ts`) | Requests are verified with the SDK's `validateRequest`, which also passes Twilio's documented example as a unit test. Outbound: `calls.create` (status callbacks, `timeLimit`, `machineDetection: "Enable"`). Transfer: `calls(sid).update({ twiml })`. Reconciliation: `calls(sid).fetch()` (duration, price). |
| The AI on the call | **OpenAI Realtime SIP**, official `openai` SDK 7.43.0 (`realtime.calls.accept/reject/hangup`, `webhooks.unwrap`, `OpenAIRealtimeWS` with `callID` for the sideband), model `gpt-realtime-2` | The **Vercel AI Gateway has no SIP endpoint**, so this is a direct OpenAI key (Decision in `docs/DECISIONS.md`). The SDK requires the optional `ws` peer dependency (8.22.0), which is installed. |
| Linking the two | Twilio `<Dial><Sip>sip:<project>@sip.api.openai.com;transport=tls?X-Sunleon-Conversation=<id></Sip>` | Twilio documents custom `X-` headers on `<Sip>` URIs. OpenAI's webhook type says SIP INVITE headers are passed through in `sip_headers` and should be treated as untrusted. Whether the custom header arrives end to end is **unverified live**; it's the first thing the live checklist checks. |

**Ghana availability** (Twilio's regulatory and voice guidelines, read on 2026-10-23):
- Ghana mobile numbers exist for **businesses only**. They need business registration, a Ghana address and a letter of authorization.
- Domestic and international inbound and outbound calls are supported.
- Domestic outbound caller ID is "Local (Non-guaranteed)".
- Emergency calls aren't supported.
- Pricing was not verified.

**Africa's Talking** was considered: its help centre lists voice in Ghana. It wasn't chosen because its voice API is callback/XML-based, and no realtime audio or SIP route into OpenAI was found in its public docs. It remains an option for Ghana numbers if Twilio KYC is a problem, via its SIP trunking, unverified.

**Verified vs not:**
- **Verified, with tests and real HTTP, without credentials:** signature checks for both providers; the whole call lifecycle against our webhook routes; the exact SDK calls we make (contract tests with the SDKs mocked); and one real accept request reaching OpenAI, refused for a test key.
- **Not verified (BLOCKED on a Twilio account, a number and an OpenAI key):**
  - a real call and the custom SIP header passing through
  - OpenAI accepting our session config
  - the sideband events matching the SDK types
  - transfer audio
  - answering-machine detection
  - Twilio's real status-callback and Call-record values


## Hosting / infrastructure (ongoing)

| Need | Candidates to evaluate | Notes |
|---|---|---|
| Web hosting | Vercel | Preferred per spec; no project linked yet in this session |
| Managed Postgres | Neon or Vercel Postgres (via Vercel Marketplace) | Required before production deploy — not yet provisioned |
| Object storage | S3-compatible (Vercel Blob, Cloudflare R2, or AWS S3) | Needed starting Phase 2 for uploaded documents |
| Background jobs | TBD once a concrete async workload exists (ingestion, voice session cleanup) | Avoid adopting a job system before there's real async work to justify it (YAGNI) |

## Credentials needed from the developer, by phase

- **Phases 2 and 3 (now):** `AI_GATEWAY_API_KEY` — one key unblocks both real embeddings and real voice sessions. It must have access to `openai/gpt-realtime-2` on the Gateway (check the Gateway model list for your team). Allowed embed domains are configured per agent in Agent Studio, not via env vars.
- **Before production (any phase):** a managed Postgres provider with pgvector support, an S3-compatible object storage provider (to replace the local-disk adapter), and a linked Vercel project.
- **Phase 4:** Paystack account and secret key (`PAYSTACK_SECRET_KEY`, which also verifies webhooks), GHS plans created in the Paystack dashboard, the webhook URL set; plus `CRON_SECRET` for the session sweeper. Until then, platform admins assign plans manually.
- **Phase 5:** nothing new. `AI_GATEWAY_API_KEY` also unlocks summaries; `CRON_SECRET` now also runs the retention job. Optional later: an error-tracking service and an alerting channel.
- **Phase 6:** a Twilio account (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) with a voice number (a Ghana number needs business KYC), and an OpenAI platform project with Realtime access (`OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, and a `realtime.call.incoming` project webhook whose secret is `OPENAI_WEBHOOK_SECRET`).

None of these blocked Phase 1 or the non-embedding parts of Phase 2.
