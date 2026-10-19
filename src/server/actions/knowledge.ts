"use server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole } from "@/server/auth/tenant";
import {
  createFaqSourceSchema,
  createManualSourceSchema,
  createUrlSourceSchema,
  ALLOWED_FILE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
} from "@/lib/validation/knowledge";
import { getStorageAdapter } from "@/server/knowledge/storage";
import { processKnowledgeSource } from "@/server/knowledge/pipeline";

export type KnowledgeActionResult = { ok: true; sourceId?: string } | { ok: false; error: string };

async function assertAgentInOrg(organizationId: string, agentId: string) {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, organizationId } });
  if (!agent) {
    throw new Error("Agent not found in this organization.");
  }
}

async function runPipelineIgnoringErrors(sourceId: string, organizationId: string) {
  // Failures are already persisted on the KnowledgeSource row (status=FAILED,
  // errorMessage) by processKnowledgeSource itself — surfaced in the UI via that
  // status field, not as a thrown action error.
  try {
    await processKnowledgeSource(sourceId, organizationId);
  } catch {
    // intentionally swallowed — see comment above
  }
}

export async function createFaqSource(
  organizationSlug: string,
  formData: FormData
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = createFaqSourceSchema.safeParse({
    agentId: formData.get("agentId"),
    title: formData.get("title"),
    question: formData.get("question"),
    answer: formData.get("answer"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await assertAgentInOrg(context.organization.id, parsed.data.agentId);

  const source = await prisma.knowledgeSource.create({
    data: {
      organizationId: context.organization.id,
      agentId: parsed.data.agentId,
      type: "FAQ",
      title: parsed.data.title,
      rawContent: `Q: ${parsed.data.question}\nA: ${parsed.data.answer}`,
    },
  });

  await runPipelineIgnoringErrors(source.id, context.organization.id);
  return { ok: true, sourceId: source.id };
}

export async function createManualSource(
  organizationSlug: string,
  formData: FormData
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = createManualSourceSchema.safeParse({
    agentId: formData.get("agentId"),
    title: formData.get("title"),
    content: formData.get("content"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await assertAgentInOrg(context.organization.id, parsed.data.agentId);

  const source = await prisma.knowledgeSource.create({
    data: {
      organizationId: context.organization.id,
      agentId: parsed.data.agentId,
      type: "MANUAL",
      title: parsed.data.title,
      rawContent: parsed.data.content,
    },
  });

  await runPipelineIgnoringErrors(source.id, context.organization.id);
  return { ok: true, sourceId: source.id };
}

export async function createUrlSource(
  organizationSlug: string,
  formData: FormData
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const parsed = createUrlSourceSchema.safeParse({
    agentId: formData.get("agentId"),
    url: formData.get("url"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  await assertAgentInOrg(context.organization.id, parsed.data.agentId);

  const source = await prisma.knowledgeSource.create({
    data: {
      organizationId: context.organization.id,
      agentId: parsed.data.agentId,
      type: "URL",
      title: parsed.data.url,
      sourceUrl: parsed.data.url,
    },
  });

  await runPipelineIgnoringErrors(source.id, context.organization.id);
  return { ok: true, sourceId: source.id };
}

export async function createFileSource(
  organizationSlug: string,
  formData: FormData
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const agentId = formData.get("agentId");
  const file = formData.get("file");

  if (typeof agentId !== "string" || !agentId) {
    return { ok: false, error: "Agent is required." };
  }
  if (!(file instanceof File)) {
    return { ok: false, error: "A file is required." };
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_FILE_EXTENSIONS.includes(extension as never)) {
    return { ok: false, error: `Unsupported file type: .${extension}` };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "File is too large (max 10 MB)." };
  }

  await assertAgentInOrg(context.organization.id, agentId);

  const buffer = Buffer.from(await file.arrayBuffer());
  const storageKey = await getStorageAdapter().put(buffer, extension);

  const source = await prisma.knowledgeSource.create({
    data: {
      organizationId: context.organization.id,
      agentId,
      type: "FILE",
      title: file.name,
      storageKey,
    },
  });

  await runPipelineIgnoringErrors(source.id, context.organization.id);
  return { ok: true, sourceId: source.id };
}

export async function retryKnowledgeSource(
  organizationSlug: string,
  sourceId: string
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, organizationId: context.organization.id },
  });
  if (!source) {
    return { ok: false, error: "Knowledge source not found." };
  }

  await runPipelineIgnoringErrors(source.id, context.organization.id);
  return { ok: true, sourceId: source.id };
}

export async function deleteKnowledgeSource(
  organizationSlug: string,
  sourceId: string
): Promise<KnowledgeActionResult> {
  const context = await requireOrgContext(organizationSlug);
  requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, organizationId: context.organization.id },
  });
  if (!source) {
    return { ok: false, error: "Knowledge source not found." };
  }

  if (source.storageKey) {
    await getStorageAdapter().delete(source.storageKey);
  }
  await prisma.knowledgeSource.delete({ where: { id: source.id } });

  return { ok: true };
}
