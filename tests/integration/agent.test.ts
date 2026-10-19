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

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => mockContext),
  requireCurrentUser: vi.fn(async () => mockContext.user),
}));

const { createAgent, updateAgentDraft, publishAgentVersion, rollbackAgentVersion, archiveAgent } =
  await import("@/server/actions/agent");

function formData(fields: Record<string, string | string[]>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) form.append(key, v);
    } else {
      form.set(key, value);
    }
  }
  return form;
}

describe("agent actions", () => {
  beforeEach(async () => {
    await resetDatabase();

    const organization = await prisma.organization.create({ data: { name: "Org A", slug: "org-a" } });
    const owner = await prisma.user.create({
      data: { email: "owner@example.com", name: "Owner", passwordHash: "x" },
    });
    const membership = await prisma.membership.create({
      data: { userId: owner.id, organizationId: organization.id, role: "OWNER" },
    });
    mockContext = { user: owner, organization, role: "OWNER", membershipId: membership.id };
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("creates an agent with an initial unpublished draft version", async () => {
    const result = await createAgent("org-a", formData({ name: "Support Bot" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const versions = await prisma.agentVersion.findMany({ where: { agentId: result.agentId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].publishedAt).toBeNull();
  });

  it("updates the draft without creating a new version row until published", async () => {
    const created = await createAgent("org-a", formData({ name: "Support Bot" }));
    if (!created.ok || !created.agentId) throw new Error("expected success");

    await updateAgentDraft(
      "org-a",
      created.agentId,
      formData({ instructions: "Answer only about opening hours.", languages: ["en"], leadCaptureEnabled: "" })
    );
    await updateAgentDraft(
      "org-a",
      created.agentId,
      formData({ instructions: "Answer about hours and location.", languages: ["en"], leadCaptureEnabled: "" })
    );

    const versions = await prisma.agentVersion.findMany({ where: { agentId: created.agentId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].instructions).toBe("Answer about hours and location.");
  });

  it("publishing locks the draft and creates a fresh draft on the next edit", async () => {
    const created = await createAgent("org-a", formData({ name: "Support Bot" }));
    if (!created.ok || !created.agentId) throw new Error("expected success");

    await updateAgentDraft(
      "org-a",
      created.agentId,
      formData({ instructions: "v1 instructions", languages: ["en"], leadCaptureEnabled: "" })
    );
    const publishResult = await publishAgentVersion("org-a", created.agentId);
    expect(publishResult.ok).toBe(true);

    const agentAfterPublish = await prisma.agent.findUniqueOrThrow({ where: { id: created.agentId } });
    expect(agentAfterPublish.publishedVersionId).not.toBeNull();

    await updateAgentDraft(
      "org-a",
      created.agentId,
      formData({ instructions: "v2 instructions", languages: ["en"], leadCaptureEnabled: "" })
    );

    const versions = await prisma.agentVersion.findMany({
      where: { agentId: created.agentId },
      orderBy: { versionNumber: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].publishedAt).not.toBeNull();
    expect(versions[0].instructions).toBe("v1 instructions");
    expect(versions[1].publishedAt).toBeNull();
    expect(versions[1].instructions).toBe("v2 instructions");
  });

  it("rolls back to a previously published version", async () => {
    const created = await createAgent("org-a", formData({ name: "Support Bot" }));
    if (!created.ok || !created.agentId) throw new Error("expected success");

    await updateAgentDraft("org-a", created.agentId, formData({ instructions: "v1", languages: ["en"], leadCaptureEnabled: "" }));
    await publishAgentVersion("org-a", created.agentId);
    const v1 = await prisma.agentVersion.findFirstOrThrow({ where: { agentId: created.agentId, versionNumber: 1 } });

    await updateAgentDraft("org-a", created.agentId, formData({ instructions: "v2", languages: ["en"], leadCaptureEnabled: "" }));
    await publishAgentVersion("org-a", created.agentId);

    const rollbackResult = await rollbackAgentVersion("org-a", created.agentId, v1.id);
    expect(rollbackResult.ok).toBe(true);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: created.agentId } });
    expect(agent.publishedVersionId).toBe(v1.id);
  });

  it("rejects an ANALYST trying to create an agent", async () => {
    mockContext = { ...mockContext, role: "ANALYST" };
    await expect(createAgent("org-a", formData({ name: "Nope" }))).rejects.toThrow();
  });

  it("archives an agent", async () => {
    const created = await createAgent("org-a", formData({ name: "Support Bot" }));
    if (!created.ok || !created.agentId) throw new Error("expected success");

    const result = await archiveAgent("org-a", created.agentId);
    expect(result.ok).toBe(true);

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: created.agentId } });
    expect(agent.archivedAt).not.toBeNull();
  });
});
