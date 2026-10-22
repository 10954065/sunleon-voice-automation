"use server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import { createAgentSchema, updateAgentDraftSchema } from "@/lib/validation/agent";
import { embedDomainsSchema } from "@/lib/validation/voice";
import { resolveEntitlements } from "@/server/billing/entitlements";
import { lockOrganization } from "@/server/billing/quota";

export type AgentActionResult = { ok: true; agentId?: string } | { ok: false; error: string };

export async function createAgent(
  organizationSlug: string,
  formData: FormData
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = createAgentSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const agent = await prisma.$transaction(async (tx) => {
    // Locked so two concurrent creates can't both pass the plan's agent limit.
    await lockOrganization(tx, context.organization.id);
    const entitlements = await resolveEntitlements(tx, context.organization.id, new Date());
    const activeAgents = await tx.agent.count({
      where: { organizationId: context.organization.id, archivedAt: null },
    });
    if (activeAgents >= entitlements.maxAgents) {
      return null;
    }

    const created = await tx.agent.create({
      data: { organizationId: context.organization.id, name: parsed.data.name },
    });
    await tx.agentVersion.create({
      data: {
        agentId: created.id,
        versionNumber: 1,
        instructions: "You are a helpful assistant for this business. Replace these instructions with real business details before publishing.",
        languages: ["en"],
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "agent.created",
        metadata: { agentId: created.id, name: created.name },
      },
    });
    return created;
  });

  if (!agent) {
    return {
      ok: false,
      error: "Your plan's agent limit is reached. Archive an agent or change plan on the Billing page.",
    };
  }
  return { ok: true, agentId: agent.id };
}

async function getOrCreateDraftVersion(agentId: string) {
  const latest = await prisma.agentVersion.findFirst({
    where: { agentId },
    orderBy: { versionNumber: "desc" },
  });

  if (latest && !latest.publishedAt) {
    return latest;
  }

  return prisma.agentVersion.create({
    data: {
      agentId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      instructions: latest?.instructions ?? "",
      persona: latest?.persona,
      tone: latest?.tone,
      greeting: latest?.greeting,
      languages: latest?.languages ?? ["en"],
      leadCaptureEnabled: latest?.leadCaptureEnabled ?? false,
      voice: latest?.voice,
    },
  });
}

export async function updateAgentDraft(
  organizationSlug: string,
  agentId: string,
  formData: FormData
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: context.organization.id },
  });
  if (!agent) {
    return { ok: false, error: "Agent not found in this organization." };
  }

  const parsed = updateAgentDraftSchema.safeParse({
    instructions: formData.get("instructions"),
    persona: formData.get("persona") ?? "",
    tone: formData.get("tone") ?? "",
    greeting: formData.get("greeting") ?? "",
    languages: formData.getAll("languages"),
    leadCaptureEnabled: formData.get("leadCaptureEnabled") === "on",
    voice: formData.get("voice") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const draft = await getOrCreateDraftVersion(agent.id);

  await prisma.agentVersion.update({
    where: { id: draft.id },
    data: {
      instructions: parsed.data.instructions,
      persona: parsed.data.persona || null,
      tone: parsed.data.tone || null,
      greeting: parsed.data.greeting || null,
      languages: parsed.data.languages,
      leadCaptureEnabled: parsed.data.leadCaptureEnabled,
      ...(parsed.data.voice && { voice: parsed.data.voice }),
    },
  });

  return { ok: true, agentId: agent.id };
}

export async function publishAgentVersion(
  organizationSlug: string,
  agentId: string
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: context.organization.id },
  });
  if (!agent) {
    return { ok: false, error: "Agent not found in this organization." };
  }

  const draft = await prisma.agentVersion.findFirst({
    where: { agentId: agent.id, publishedAt: null },
    orderBy: { versionNumber: "desc" },
  });
  if (!draft) {
    return { ok: false, error: "There is no draft to publish." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentVersion.update({ where: { id: draft.id }, data: { publishedAt: new Date() } });
    await tx.agent.update({ where: { id: agent.id }, data: { publishedVersionId: draft.id } });
    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "agent.published",
        metadata: { agentId: agent.id, versionId: draft.id, versionNumber: draft.versionNumber },
      },
    });
  });

  return { ok: true, agentId: agent.id };
}

export async function rollbackAgentVersion(
  organizationSlug: string,
  agentId: string,
  versionId: string
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const version = await prisma.agentVersion.findFirst({
    where: { id: versionId, agentId, publishedAt: { not: null } },
    include: { agent: true },
  });
  if (!version || version.agent.organizationId !== context.organization.id) {
    return { ok: false, error: "That published version was not found." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agentId }, data: { publishedVersionId: version.id } });
    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "agent.rolled_back",
        metadata: { agentId, versionId: version.id, versionNumber: version.versionNumber },
      },
    });
  });

  return { ok: true, agentId };
}

export async function updateEmbedDomains(
  organizationSlug: string,
  agentId: string,
  formData: FormData
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: context.organization.id },
  });
  if (!agent) {
    return { ok: false, error: "Agent not found in this organization." };
  }

  const raw = String(formData.get("domains") ?? "");
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  const parsed = embedDomainsSchema.safeParse(entries);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid domains." };
  }
  const domains = Array.from(new Set(parsed.data));

  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agent.id }, data: { allowedEmbedDomains: domains } });
    await tx.auditLog.create({
      data: {
        organizationId: context.organization.id,
        actorUserId: context.user.id,
        action: "agent.embed_domains_updated",
        metadata: { agentId: agent.id, domains },
      },
    });
  });

  return { ok: true, agentId: agent.id };
}

export async function archiveAgent(
  organizationSlug: string,
  agentId: string
): Promise<AgentActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN"]);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: context.organization.id },
  });
  if (!agent) {
    return { ok: false, error: "Agent not found in this organization." };
  }

  await prisma.agent.update({ where: { id: agent.id }, data: { archivedAt: new Date() } });
  return { ok: true, agentId: agent.id };
}
