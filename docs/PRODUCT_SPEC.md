# Product Specification — Sunleon Voice

## Vision

Sunleon Voice is a multi-tenant SaaS platform that lets businesses — Ghanaian businesses first, international businesses as the product matures — build AI voice agents grounded in their own business knowledge. An agent can answer questions, capture leads, and (in later phases) handle telephone calls.

This document describes the intended product end-state across all phases. **Status markers in each section show what exists today vs. what is planned.** See `docs/PHASE_STATUS.md` for the authoritative, continuously updated phase tracker.

## Target market

- **Primary:** Ghanaian small and mid-sized businesses (retail, hospitality, services, clinics) that want a website voice agent and, eventually, phone automation.
- **Secondary:** International businesses with similar needs, once the platform is proven.
- **Explicit non-goal (for now):** Enterprise call-centre replacement. Phase 6+ territory, not attempted until Phases 1–5 are solid.

## Personas / roles

| Role | Scope | Status |
|---|---|---|
| Platform Super Admin | Cross-tenant platform operations | Schema in place (Phase 1); admin UI not built until Phase 5 |
| Business Owner | Full control of their organization | Implemented (Phase 1): can create an org, invite members |
| Business Administrator | Manage agents, knowledge, team, billing within an org | Role implemented (Phase 1); most admin surfaces land in Phase 2–4 |
| Agent Manager | Create/edit/test/publish agents | Role implemented (Phase 1); Agent Studio itself is Phase 2 |
| Analyst / Read-only | View conversations, usage, leads | Role implemented (Phase 1); analytics views are Phase 5 |

## Core user journeys (by phase)

1. **Register and create a workspace** — Phase 1 (this build).
2. **Invite teammates with a role** — Phase 1 (this build): invitation acceptance flow; sending real email invites is deferred (no email provider configured yet — see `docs/KNOWN_LIMITATIONS.md`).
3. **Configure an AI agent, upload knowledge** — Phase 2.
4. **Test a conversation, publish an agent version** — Phase 2 (config) / Phase 3 (real voice conversation).
5. **Embed a voice widget on a website** — Phase 3.
6. **View conversations, usage, leads** — Phase 5 (dashboards use Phase 1–4 data as it accumulates).
7. **Manage plan, billing, usage limits** — Phase 4: plans, usage, limits, overage budget and history are built; online payment through Paystack is built but BLOCKED until a Paystack account is configured (platform admins can assign plans manually meanwhile).
8. **Receive/make phone calls** — Phase 6.

## Illustrative pricing (NOT final — configurable, unverified economics)

| Plan | Price | Included minutes |
|---|---|---|
| Starter | GHS 299/month | 150 |
| Growth | GHS 799/month | 500 |
| Enterprise | Custom | Custom |

These numbers come directly from the product brief as placeholders. Since Phase 4 they are seeded as configurable plans (plus a free 10-minute, 14-day trial), but they must not be presented to real customers as final until provider costs are measured (Part C, Decision 2). Overage is off on every plan until then.

## Non-negotiables carried into every phase

1. Real-time **browser** voice before telephony (Decision 1).
2. Usage metering and cost controls are foundational, not bolted on later (Decision 2).
3. Ghanaian voice quality claims require native-speaker validation before being advertised (Decision 3).

## What this phase (Phase 1) actually delivers

- Account registration and login (email + password).
- Organization (workspace) creation.
- Role-based membership (Owner, Admin, Agent Manager, Analyst) scoped to an organization.
- Tenant-scoped dashboard shell.
- Public marketing landing page (no fabricated testimonials, metrics, or certifications).

Everything else in this document is forward-looking scope, not a claim about current functionality.
