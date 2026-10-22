import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { TenantAccessError } from "@/server/auth/tenant";
import { createEmbedTicket } from "@/server/voice/embedTicket";
import { resetDatabase } from "./helpers";

type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST" | "SUPER_ADMIN";
  membershipId: string;
};

let mockContext: MockContext | null = null;

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => {
    if (!mockContext) throw new TenantAccessError("You must be signed in.", 401);
    return mockContext;
  }),
}));

const testRoute = await import("@/app/api/voice/sessions/test/[agentId]/route");
const embedRoute = await import("@/app/api/voice/sessions/embed/[agentId]/route");
const tokenRoute = await import("@/app/api/voice/sessions/[conversationId]/token/route");
const endRoute = await import("@/app/api/voice/sessions/[conversationId]/end/route");
const searchRoute = await import("@/app/api/voice/tools/search-knowledge/route");
const leadsRoute = await import("@/app/api/voice/leads/route");

function post(url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

async function seed(options: { publish?: boolean; domains?: string[] } = {}) {
  const organization = await prisma.organization.create({ data: { name: "Kofi Bakery", slug: "kofi" } });
  const user = await prisma.user.create({ data: { email: "owner@example.com", name: "Owner", passwordHash: "x" } });
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
  });
  const agent = await prisma.agent.create({
    data: { organizationId: organization.id, name: "Front desk", allowedEmbedDomains: options.domains ?? [] },
  });
  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      instructions: "Answer questions about the bakery.",
      publishedAt: options.publish ? new Date() : null,
    },
  });
  if (options.publish) {
    await prisma.agent.update({ where: { id: agent.id }, data: { publishedVersionId: version.id } });
  }
  return { organization, user, membership, agent, version };
}

describe("voice API routes", () => {
  beforeEach(async () => {
    await resetDatabase();
    mockContext = null;
    delete process.env.AI_GATEWAY_API_KEY;
  });

  afterEach(() => {
    if (originalGatewayKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
    }
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe("POST /api/voice/sessions/test/[agentId]", () => {
    it("requires the organization query parameter", async () => {
      const response = await testRoute.POST(post("http://localhost/api/voice/sessions/test/x"), {
        params: Promise.resolve({ agentId: "x" }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects anonymous callers", async () => {
      const { agent } = await seed();
      const response = await testRoute.POST(post(`http://localhost/api/voice/sessions/test/${agent.id}?org=kofi`), {
        params: Promise.resolve({ agentId: agent.id }),
      });
      expect(response.status).toBe(401);
    });

    it("rejects read-only analysts", async () => {
      const { agent, organization, user, membership } = await seed();
      mockContext = { user, organization, role: "ANALYST", membershipId: membership.id };

      const response = await testRoute.POST(post(`http://localhost/api/voice/sessions/test/${agent.id}?org=kofi`), {
        params: Promise.resolve({ agentId: agent.id }),
      });
      expect(response.status).toBe(403);
    });

    it("reports the real blocker to a signed-in manager when voice credentials are missing", async () => {
      const { agent, organization, user, membership } = await seed();
      mockContext = { user, organization, role: "OWNER", membershipId: membership.id };

      const response = await testRoute.POST(post(`http://localhost/api/voice/sessions/test/${agent.id}?org=kofi`), {
        params: Promise.resolve({ agentId: agent.id }),
      });

      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("AI_GATEWAY_API_KEY");
    });
  });

  describe("POST /api/voice/sessions/embed/[agentId]", () => {
    it("rejects a request without a ticket", async () => {
      const { agent } = await seed({ publish: true, domains: ["shop.example.com"] });
      const response = await embedRoute.POST(
        post(`http://localhost/api/voice/sessions/embed/${agent.id}`, {}, { "x-forwarded-for": "10.0.0.1" }),
        { params: Promise.resolve({ agentId: agent.id }) }
      );
      expect(response.status).toBe(400);
    });

    it("rejects a forged ticket", async () => {
      const { agent } = await seed({ publish: true, domains: ["shop.example.com"] });
      const response = await embedRoute.POST(
        post(
          `http://localhost/api/voice/sessions/embed/${agent.id}`,
          { ticket: "forged-payload.forged-signature" },
          { "x-forwarded-for": "10.0.0.2" }
        ),
        { params: Promise.resolve({ agentId: agent.id }) }
      );
      expect(response.status).toBe(403);
    });

    it("tells public visitors voice is unavailable without revealing configuration details", async () => {
      const { agent } = await seed({ publish: true, domains: ["shop.example.com"] });
      const ticket = createEmbedTicket({ agentId: agent.id, host: "shop.example.com" });

      const response = await embedRoute.POST(
        post(`http://localhost/api/voice/sessions/embed/${agent.id}`, { ticket }, { "x-forwarded-for": "10.0.0.3" }),
        { params: Promise.resolve({ agentId: agent.id }) }
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("Voice is temporarily unavailable. Please try again later.");
      expect(JSON.stringify(body)).not.toContain("AI_GATEWAY_API_KEY");
    });

    it("rate-limits repeated session requests from one client", async () => {
      const { agent } = await seed({ publish: true, domains: ["shop.example.com"] });
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const response = await embedRoute.POST(
          post(`http://localhost/api/voice/sessions/embed/${agent.id}`, {}, { "x-forwarded-for": "10.0.0.99" }),
          { params: Promise.resolve({ agentId: agent.id }) }
        );
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it("caps session preparation per agent even when every request claims a different IP", async () => {
      const { agent } = await seed({ publish: true, domains: ["shop.example.com"] });
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const response = await embedRoute.POST(
          post(`http://localhost/api/voice/sessions/embed/${agent.id}`, {}, { "x-forwarded-for": `203.0.113.${i}` }),
          { params: Promise.resolve({ agentId: agent.id }) }
        );
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
      expect(statuses[30]).toBe(429);
    });
  });

  describe("POST /api/voice/sessions/[conversationId]/token", () => {
    it("rejects a malformed conversation id", async () => {
      const response = await tokenRoute.POST(post("http://localhost/api/voice/sessions/nope/token"), {
        params: Promise.resolve({ conversationId: "nope" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 409 for an unknown conversation", async () => {
      const conversationId = randomUUID();
      const response = await tokenRoute.POST(post(`http://localhost/api/voice/sessions/${conversationId}/token`), {
        params: Promise.resolve({ conversationId }),
      });
      expect(response.status).toBe(409);
    });

    it("fails honestly against the real provider when no credentials are configured", async () => {
      const { organization, agent, version } = await seed();
      const conversation = await prisma.conversation.create({
        data: {
          id: randomUUID(),
          organizationId: organization.id,
          agentId: agent.id,
          agentVersionId: version.id,
          channel: "TEST",
        },
      });

      const response = await tokenRoute.POST(
        post(`http://localhost/api/voice/sessions/${conversation.id}/token`, { sessionConfig: { instructions: "ignored" } }),
        { params: Promise.resolve({ conversationId: conversation.id }) }
      );

      expect(response.status).toBe(503);
      const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(updated.status).toBe("FAILED");
      expect(updated.errorMessage).toContain("AI_GATEWAY_API_KEY");
    });
  });

  describe("supporting routes", () => {
    it("ends a session and treats a repeat as a no-op", async () => {
      const { organization, agent, version } = await seed();
      const conversation = await prisma.conversation.create({
        data: {
          id: randomUUID(),
          organizationId: organization.id,
          agentId: agent.id,
          agentVersionId: version.id,
          channel: "TEST",
        },
      });
      const call = () =>
        endRoute.POST(post(`http://localhost/api/voice/sessions/${conversation.id}/end`, { reason: "user_ended" }), {
          params: Promise.resolve({ conversationId: conversation.id }),
        });

      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      expect(await prisma.usageEvent.count({ where: { conversationId: conversation.id, type: "SESSION_ENDED" } })).toBe(1);
    });

    it("rejects an end request with a malformed id", async () => {
      const response = await endRoute.POST(post("http://localhost/api/voice/sessions/x/end", {}), {
        params: Promise.resolve({ conversationId: "x" }),
      });
      expect(response.status).toBe(400);
    });

    it("validates knowledge search input and never accepts a tenant id from the body", async () => {
      const response = await searchRoute.POST(
        post("http://localhost/api/voice/tools/search-knowledge", { organizationId: "someone-else", query: "hours" })
      );
      expect(response.status).toBe(400);
    });

    it("validates lead submissions", async () => {
      const response = await leadsRoute.POST(
        post("http://localhost/api/voice/leads", { conversationId: randomUUID(), note: "no contact info" })
      );
      expect(response.status).toBe(400);
    });
  });
});
