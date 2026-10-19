import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "./helpers";

type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST" | "SUPER_ADMIN";
  membershipId: string;
};

let mockContext: MockContext;
let agentId: string;

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => mockContext),
}));

const {
  createFaqSource,
  createManualSource,
  createUrlSource,
  retryKnowledgeSource,
  deleteKnowledgeSource,
} = await import("@/server/actions/knowledge");

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("knowledge source actions", () => {
  beforeEach(async () => {
    await resetDatabase();

    const organization = await prisma.organization.create({ data: { name: "Org A", slug: "org-a" } });
    const owner = await prisma.user.create({
      data: { email: "owner@example.com", name: "Owner", passwordHash: "x" },
    });
    const membership = await prisma.membership.create({
      data: { userId: owner.id, organizationId: organization.id, role: "OWNER" },
    });
    const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: "Agent" } });
    agentId = agent.id;
    mockContext = { user: owner, organization, role: "OWNER", membershipId: membership.id };
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("creates a FAQ source combining question and answer into rawContent", async () => {
    const result = await createFaqSource(
      "org-a",
      formData({ agentId, title: "Hours", question: "When are you open?", answer: "9am-5pm" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.sourceId) throw new Error("expected success");

    const source = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: result.sourceId } });
    expect(source.type).toBe("FAQ");
    expect(source.rawContent).toContain("When are you open?");
    expect(source.rawContent).toContain("9am-5pm");
  });

  it("creates a MANUAL source and leaves it FAILED without embedding credentials (expected in this environment)", async () => {
    const result = await createManualSource(
      "org-a",
      formData({ agentId, title: "Policies", content: "Refunds are available within 14 days." })
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.sourceId) throw new Error("expected success");

    const source = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: result.sourceId } });
    // No AI_GATEWAY_API_KEY is configured in this test environment — this documents the
    // real, current failure mode rather than hiding it. See docs/KNOWN_LIMITATIONS.md.
    expect(source.status).toBe("FAILED");
    expect(source.errorMessage).toContain("AI_GATEWAY_API_KEY");
  });

  it("rejects creating a source for an agent outside the caller's organization", async () => {
    const otherOrg = await prisma.organization.create({ data: { name: "Org B", slug: "org-b" } });
    const otherAgent = await prisma.agent.create({ data: { organizationId: otherOrg.id, name: "Other" } });

    await expect(
      createManualSource(
        "org-a",
        formData({ agentId: otherAgent.id, title: "x", content: "y" })
      )
    ).rejects.toThrow();
  });

  it("rejects an ANALYST trying to add a URL source", async () => {
    mockContext = { ...mockContext, role: "ANALYST" };
    await expect(
      createUrlSource("org-a", formData({ agentId, url: "https://example.com" }))
    ).rejects.toThrow();
  });

  it("retry re-attempts processing on a failed source", async () => {
    const created = await createManualSource(
      "org-a",
      formData({ agentId, title: "Policies", content: "Refunds within 14 days." })
    );
    if (!created.ok || !created.sourceId) throw new Error("expected success");

    const retried = await retryKnowledgeSource("org-a", created.sourceId);
    expect(retried.ok).toBe(true);

    const source = await prisma.knowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } });
    expect(source.status).toBe("FAILED"); // still no credentials — same documented gap
  });

  it("deletes a source and cascades its chunks", async () => {
    const created = await createFaqSource(
      "org-a",
      formData({ agentId, title: "Hours", question: "Open when?", answer: "9-5" })
    );
    if (!created.ok || !created.sourceId) throw new Error("expected success");

    const result = await deleteKnowledgeSource("org-a", created.sourceId);
    expect(result.ok).toBe(true);

    const source = await prisma.knowledgeSource.findUnique({ where: { id: created.sourceId } });
    expect(source).toBeNull();

    const chunks = await prisma.knowledgeChunk.findMany({ where: { sourceId: created.sourceId } });
    expect(chunks).toHaveLength(0);
  });
});
