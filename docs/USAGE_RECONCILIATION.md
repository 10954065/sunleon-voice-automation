# Usage Reconciliation — Sunleon Voice

How phone-call usage is measured, recorded, and checked against what the providers say. Written for the platform operator (who pays Twilio and OpenAI) and for anyone auditing a customer's bill.

**Status:** the code paths below are built and tested with test doubles at the provider boundary. No reconciliation has run against a real Twilio account yet (no credentials), so every step marked "live" below is still to be done once.

## 1. Two kinds of usage per phone call

Every phone call can produce two rows in `UsageLedgerEntry`, each with its own idempotency key, so a retried or duplicated webhook can never record either twice.

| Metric | What it measures | Who pays | Counts against the customer's plan? | Idempotency key |
|---|---|---|---|---|
| `VOICE_SECONDS` | How long the AI (OpenAI Realtime over SIP) was on the call | Customer, via the plan allowance; platform pays OpenAI | **Yes** | `voice-session:<conversationId>` |
| `TELEPHONY_SECONDS` | How long the whole call lasted on Twilio's network | Platform cost only (Twilio bills the platform) | **No** | `telephony:<conversationId>` |

Quota and the customer's usage page count `VOICE_SECONDS` only. The platform cost report sums the cost estimates of both, so phone margins include carrier cost.

## 2. Where each number comes from

### AI seconds (`VOICE_SECONDS`), in order of preference

1. **`provider_reported`**: Twilio's `DialCallDuration` for the SIP leg to OpenAI. It arrives at the `<Dial action>` webhook (`/api/telephony/twilio/ai-dial-result`) when the AI leg ends. This is the provider's own measurement of how long the AI was connected.
2. **`server_clock`**: our clock from the moment we accepted the AI leg (`Conversation.tokenIssuedAt`) to the moment we saw it end. It's used when the Dial action never arrives and the terminal status callback settles the call, and when the AI hands the call to a person (transfer).
3. **`sweeper_reservation`**: if neither arrives, the daily sweeper closes the conversation after its reservation plus grace and charges the full reservation (at most 270 seconds for a phone call), as for browser sessions. This is a conservative estimate, and it's labelled so on the conversation page.

The charge is **never more than the reservation**, whatever the source. When the measured figure is higher, it's kept as `measuredSeconds` on the `SESSION_ENDED` usage event, so the difference is visible.

Calls the AI never answered (AI leg failed, answering machine, no answer, opted out at the keypad, quota fallback) record **no** `VOICE_SECONDS` row.

### Carrier seconds (`TELEPHONY_SECONDS`)

1. **`provider_reported`**: Twilio's `CallDuration` from the terminal status callback (`/api/telephony/twilio/status`, `CallStatus` completed/busy/no-answer/failed/canceled). It's recorded only when it's above zero.
2. **`provider_reconciliation`**: if that callback never arrived, the daily reconciliation job (section 3) fetches Twilio's Call record and records the duration from there.

## 3. The daily reconciliation job

The job is `GET /api/cron/reconcile-telephony`, run by Vercel Cron at 04:00 UTC and protected by `CRON_SECRET`. The code is `src/server/telephony/reconciliation.ts`.

For every phone call that has a Twilio CallSid, is not yet reconciled, is older than 10 minutes and is younger than 7 days, it does this (up to 200 calls per run):

1. Fetches the call from Twilio's REST API (`GET /Calls/{CallSid}`): `status`, `duration`, `price`, `price_unit`.
2. If Twilio says the call is still in progress, it leaves it for the next run.
3. Stores Twilio's price, in micro-units of its currency, on `PhoneCall.carrierPriceMicros` and `carrierPriceUnit`, and marks the call `reconciledAt`.
4. If no carrier row exists yet (the callback was lost), it records `TELEPHONY_SECONDS` from Twilio's duration with source `provider_reconciliation`.
5. If the callback's duration and Twilio's record **disagree**, it doesn't overwrite either. It reports a **mismatch** (conversation, callback seconds, Twilio seconds) in the job's result, which is stored on the `JobRun` and shown on `/admin/telephony`.

Re-running the job changes nothing: reconciled calls are skipped, and the carrier row is keyed per conversation. A Twilio API failure on one call is counted (`fetchFailures`) and retried on the next run. If Twilio isn't configured, the job records a successful run that says it was skipped.

## 4. The reconciliation report (`/admin/telephony`)

For the last 30 days, per organization:

| Column | Source | What to compare it with |
|---|---|---|
| Calls | `PhoneCall` rows | Twilio's call log for the same numbers |
| AI billed | Sum of `VOICE_SECONDS` rows with provider `openai-realtime-sip` | "AI leg (Twilio)" |
| AI leg (Twilio) | Sum of `PhoneCall.aiLegSeconds` (DialCallDuration) | OpenAI's Realtime usage for the project |
| Carrier ledger | Sum of `TELEPHONY_SECONDS` rows | "Carrier records" |
| Carrier records | Sum of `PhoneCall.carrierSeconds` | Twilio's usage records and invoice |
| Unreconciled | Calls with a CallSid not yet checked against Twilio | Should be 0 a day after the calls |

How to read the differences:
- **AI billed < AI leg**: some calls hit the reservation cap (the excess is platform cost, visible as `measuredSeconds`) or were transferred (billed to the moment of transfer).
- **AI billed > AI leg**: some calls were charged by `server_clock` or the sweeper because the Dial action was lost. Look for conversations with those sources.
- **Carrier ledger ≠ carrier records**: a mismatch from the latest run, listed under the table.

## 5. Monthly close (manual, live — not yet done)

Once a month, before invoicing or reviewing margins:

1. In `/admin/telephony`, check that **Unreconciled** is 0. If not, call the cron route by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/reconcile-telephony`.
2. **Twilio:** compare "Carrier records" (seconds) and the summed `carrierPriceMicros` with Twilio Console → Monitor → Usage (Programmable Voice) and the invoice for the same period. Twilio bills per started minute, so its minute totals run slightly above our second totals ÷ 60.
3. **OpenAI:** compare "AI leg (Twilio)" with the OpenAI project's Realtime usage for the period. OpenAI bills by audio tokens, not seconds, so convert with the measured cost per minute (step 4); expect agreement within a few percent.
4. **Update the cost rates** in `/admin/billing` → Provider cost rates ("Phone calls — AI", "Twilio inbound minutes", "Twilio outbound minutes") from those invoices, with a note giving the source. New ledger rows use the new rates; old rows keep their snapshot.
5. Investigate any listed mismatch: open the conversation and compare it with the call in Twilio's log.

The customer is billed on `VOICE_SECONDS` only, which is capped at their reservation, so no reconciliation outcome can raise a customer's past charge. Corrections in the customer's favour (for example a sweeper charge on a call Twilio shows was short) are made today as manual credits; there's no automatic adjustment row. See `docs/KNOWN_LIMITATIONS.md`.
