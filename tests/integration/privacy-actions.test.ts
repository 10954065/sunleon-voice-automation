import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { prisma } from "@/server/db/client";
import { TenantAccessError } from "@/server/auth/tenant";
import { resetDatabase } from "./helpers";

type Role = "OWNER" | "ADMIN" | "AGENT_MANAGER" | "ANALYST";
type MockContext = {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; slug: string; name: string };
  role: Role;
  membershipId: string;
};

let mockContext: MockContext | null;

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async (slug: string) => {
    if (!mockContext) throw new TenantAccessError("You must be signed in.", 401);
    if (mockContext.organization.slug !== slug) throw new TenantAccessError("You do not have access to this organization.", 403);
    return mockContext;
  }),
  requireCurrentUser: vi.fn(async () => mockContext?.user),
}));

const { updateDataSettings, deleteConversationTranscript, deleteAllTranscripts, eraseContact } = await import(
  "@/server/actions/privacy"
);
const { updateLeadStatus, deleteLead } = await import("@/server/actions/leads");
const { generateConversationSummary } = await import("@/server/actions/conversations");
const { GET: exportRoute } = await import("@/app/api/orgs/[orgSlug]/exports/[kind]/route");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function seed(slug: string, role: Role) {
  const organization = await prisma.organization.create({ data: { name: `Org ${slug}`, slug } });
  const user = await prisma.user.create({ data: { email: `${role.toLowerCase()}@${slug}.example`, name: role, passwordHash: "x" } });
  const membership = await prisma.membership.create({ data: { userId: user.id, organizationId: organization.id, role } });
  const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: "Agent" } });
  const version = await prisma.agentVersion.create({ data: { agentId: agent.id, versionNumber: 1, instructions: "x" } });
  const conversation = await prisma.conversation.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: organization.id,
      agentId: agent.id,
      agentVersionId: version.id,
      channel: "EMBED",
      status: "COMPLETED",
      outcome: "LEAD_CAPTURED",
      tokenIssuedAt: new Date(),
      endedAt: new Date(),
      transcriptConsent: true,
    },
  });
  await prisma.conversationTranscript.create({
    data: { conversationId: conversation.id, organizationId: organization.id, entries: [{ role: "user", text: "Hi" }], entryCount: 1 },
  });
  const lead = await prisma.lead.create({
    data: {
      organizationId: organization.id,
      agentId: agent.id,
      conversationId: conversation.id,
      name: "=HYPERLINK(\"http://evil.example\")",
      email: "ama@example.com",
      phone: "0241234567",
    },
  });
  mockContext = { user, organization, role, membershipId: membership.id };
  return { organization, user, conversation, lead };
}

async function callExport(slug: string, kind: string) {
  return exportRoute(new NextRequest(`http://localhost/api/orgs/${slug}/exports/${kind}?days=30`), {
    params: Promise.resolve({ orgSlug: slug, kind }),
  });
}

describe("privacy, lead and export authorization", () => {
  beforeEach(async () => {
    await resetDatabase();
    mockContext = null;
  });

  afterAll(async () => {
    await resetDatabase();
  });

  describe("data settings", () => {
    it("lets the owner change transcript storage and retention, with an audit entry", async () => {
      const { organization } = await seed("settings", "OWNER");

      const result = await updateDataSettings(
        "settings",
        form({ storeTranscripts: "on", transcriptRetentionDays: "14", leadRetentionDays: "90" })
      );

      expect(result.ok).toBe(true);
      expect(await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } })).toMatchObject({
        storeTranscripts: true,
        transcriptRetentionDays: 14,
        leadRetentionDays: 90,
      });
      expect(await prisma.auditLog.findFirst({ where: { action: "privacy.settings_updated" } })).not.toBeNull();
    });

    it("rejects out-of-range retention and non-owners", async () => {
      await seed("settings-bad", "OWNER");
      const tooLong = await updateDataSettings(
        "settings-bad",
        form({ transcriptRetentionDays: "400", leadRetentionDays: "90" })
      );
      expect(tooLong).toEqual({ ok: false, error: "Transcripts can be kept for at most 365 days." });

      mockContext = { ...mockContext!, role: "ADMIN" };
      await expect(
        updateDataSettings("settings-bad", form({ transcriptRetentionDays: "10", leadRetentionDays: "90" }))
      ).rejects.toThrow(TenantAccessError);
    });
  });

  describe("deletion", () => {
    it("deletes one transcript for an admin but not for an agent manager or analyst", async () => {
      const { conversation } = await seed("one", "AGENT_MANAGER");
      await expect(deleteConversationTranscript("one", conversation.id)).rejects.toThrow(TenantAccessError);
      mockContext = { ...mockContext!, role: "ANALYST" };
      await expect(deleteConversationTranscript("one", conversation.id)).rejects.toThrow(TenantAccessError);

      mockContext = { ...mockContext!, role: "ADMIN" };
      expect(await deleteConversationTranscript("one", conversation.id)).toEqual({
        ok: true,
        message: "Transcript and summary deleted.",
      });
      expect(await prisma.conversationTranscript.count()).toBe(0);
      expect(await prisma.auditLog.findFirst({ where: { action: "privacy.transcript_deleted" } })).not.toBeNull();
    });

    it("cannot delete another organization's transcript, even by id", async () => {
      const theirs = await seed("theirs", "OWNER");
      await seed("mine", "OWNER");

      const result = await deleteConversationTranscript("mine", theirs.conversation.id);

      expect(result.ok).toBe(false);
      expect(await prisma.conversationTranscript.count({ where: { organizationId: theirs.organization.id } })).toBe(1);
    });

    it("requires the typed confirmation to delete every transcript", async () => {
      await seed("all", "OWNER");
      expect(await deleteAllTranscripts("all", form({ confirmation: "yes" }))).toEqual({
        ok: false,
        error: "Type DELETE to confirm.",
      });
      expect(await deleteAllTranscripts("all", form({ confirmation: "DELETE" }))).toEqual({
        ok: true,
        message: "Deleted 1 stored transcript.",
      });
      expect(await prisma.conversationTranscript.count()).toBe(0);
    });

    it("erases a contact without writing the contact details into the audit log", async () => {
      await seed("erase", "ADMIN");

      expect(await eraseContact("erase", form({ email: "", phone: "123" }))).toEqual({
        ok: false,
        error: "Enter at least 7 digits of the phone number.",
      });
      const result = await eraseContact("erase", form({ email: "ama@example.com", phone: "" }));

      expect(result).toEqual({ ok: true, message: "Deleted 1 lead and 1 transcript." });
      const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.contact_erased" } });
      expect(JSON.stringify(entry.metadata)).not.toContain("ama@example.com");
      expect(entry.metadata).toEqual({ matchedBy: ["email"], leadsDeleted: 1, transcriptsDeleted: 1 });
    });
  });

  describe("leads", () => {
    it("lets an agent manager change status but not an analyst", async () => {
      const { lead } = await seed("status", "ANALYST");
      await expect(updateLeadStatus("status", lead.id, "CONTACTED")).rejects.toThrow(TenantAccessError);

      mockContext = { ...mockContext!, role: "AGENT_MANAGER" };
      expect(await updateLeadStatus("status", lead.id, "CONTACTED")).toEqual({ ok: true });
      expect(await updateLeadStatus("status", lead.id, "WON")).toEqual({ ok: false, error: "Unknown status." });
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("CONTACTED");
    });

    it("scopes lead changes to the caller's organization", async () => {
      const theirs = await seed("lead-theirs", "OWNER");
      await seed("lead-mine", "OWNER");

      expect(await updateLeadStatus("lead-mine", theirs.lead.id, "CLOSED")).toEqual({ ok: false, error: "Lead not found." });
      expect(await deleteLead("lead-mine", theirs.lead.id)).toEqual({ ok: false, error: "Lead not found." });
      expect(await prisma.lead.findUnique({ where: { id: theirs.lead.id } })).not.toBeNull();
    });

    it("deletes a lead for an owner and records only its id", async () => {
      const { lead } = await seed("delete-lead", "OWNER");

      expect(await deleteLead("delete-lead", lead.id)).toEqual({ ok: true });
      const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "lead.deleted" } });
      expect(entry.metadata).toEqual({ leadId: lead.id });
    });
  });

  describe("summaries", () => {
    it("is not available to analysts", async () => {
      const { conversation } = await seed("summary-role", "ANALYST");
      await expect(generateConversationSummary("summary-role", conversation.id)).rejects.toThrow(TenantAccessError);
    });

    it("validates the id and reports BLOCKED without a provider key for an agent manager", async () => {
      const { conversation } = await seed("summary-manager", "AGENT_MANAGER");
      const originalKey = process.env.AI_GATEWAY_API_KEY;
      delete process.env.AI_GATEWAY_API_KEY;
      try {
        expect(await generateConversationSummary("summary-manager", "not-a-uuid")).toEqual({
          ok: false,
          error: "Invalid conversation.",
        });
        const result = await generateConversationSummary("summary-manager", conversation.id);
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.error).toMatch(/AI_GATEWAY_API_KEY is not set/);
      } finally {
        if (originalKey !== undefined) process.env.AI_GATEWAY_API_KEY = originalKey;
      }
    });

    it("caps summary requests per organization", async () => {
      const { conversation } = await seed("summary-limit", "OWNER");
      const results = await Promise.all(
        Array.from({ length: 12 }, () => generateConversationSummary("summary-limit", conversation.id))
      );
      expect(results.filter((result) => !result.ok && /Too many summaries/.test(result.error))).toHaveLength(2);
    });
  });

  describe("CSV export", () => {
    it("exports conversation metadata for any member, without transcripts or contact details", async () => {
      const { conversation } = await seed("export", "ANALYST");

      const response = await callExport("export", "conversations");
      const csv = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("x-export-rows")).toBe("1");
      expect(csv).toContain(conversation.id);
      expect(csv).toContain("LEAD_CAPTURED");
      expect(csv).not.toContain("ama@example.com");
      expect(csv).not.toContain("Hi");
      expect(await prisma.auditLog.findFirst({ where: { action: "export.conversations" } })).not.toBeNull();
    });

    it("restricts lead export to owners and admins, and neutralises spreadsheet formulas", async () => {
      await seed("export-leads", "ANALYST");
      expect((await callExport("export-leads", "leads")).status).toBe(403);

      mockContext = { ...mockContext!, role: "ADMIN" };
      const response = await callExport("export-leads", "leads");
      const csv = await response.text();

      expect(response.status).toBe(200);
      expect(csv).toContain("ama@example.com");
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    });

    it("answers 404 for another organization and 401 when signed out", async () => {
      await seed("export-theirs", "OWNER");
      await seed("export-mine", "OWNER");

      expect((await callExport("export-theirs", "conversations")).status).toBe(404);
      expect((await callExport("export-mine", "transcripts")).status).toBe(404);
      mockContext = null;
      expect((await callExport("export-mine", "conversations")).status).toBe(401);
    });
  });
});
