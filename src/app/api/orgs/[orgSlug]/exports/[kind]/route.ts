import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { requireRole, TenantAccessError } from "@/server/auth/tenant";
import { exportConversations, exportLeads } from "@/server/exports/csv";
import { exportQuerySchema, firstValues, rangeForDays } from "@/lib/validation/history";

const EXPORT_KINDS = ["conversations", "leads"] as const;
type ExportKind = (typeof EXPORT_KINDS)[number];

function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

async function resolveContext(orgSlug: string) {
  try {
    return { ok: true as const, context: await requireOrgContext(orgSlug) };
  } catch (error) {
    if (error instanceof TenantAccessError) {
      // Non-members get 404 so the endpoint never confirms that an organization exists.
      return error.status === 401
        ? { ok: false as const, response: NextResponse.json({ error: error.message }, { status: 401 }) }
        : { ok: false as const, response: NextResponse.json({ error: "Not found." }, { status: 404 }) };
    }
    throw error;
  }
}

/**
 * CSV download for one organization. Membership is resolved from the session, never from the slug
 * alone. Conversation metadata is exportable by every member; leads are visitors' personal data, so
 * only owners and admins can export them. Every export is audit-logged.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ orgSlug: string; kind: string }> }) {
  const { orgSlug, kind } = await params;
  if (!isExportKind(kind)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const resolved = await resolveContext(orgSlug);
  if (!resolved.ok) {
    return resolved.response;
  }
  const { context } = resolved;
  if (kind === "leads") {
    try {
      requireRole(context.role, ["OWNER", "ADMIN"]);
    } catch (error) {
      if (error instanceof TenantAccessError) {
        return NextResponse.json({ error: "Only owners and admins can export leads." }, { status: 403 });
      }
      throw error;
    }
  }

  const { days } = exportQuerySchema.parse(firstValues(Object.fromEntries(request.nextUrl.searchParams)));
  const range = rangeForDays(days);
  const scope = { organizationId: context.organization.id, ...range };
  const result = kind === "leads" ? await exportLeads(scope) : await exportConversations(scope);

  await prisma.auditLog.create({
    data: {
      organizationId: context.organization.id,
      actorUserId: context.user.id,
      action: `export.${kind}`,
      metadata: { days, rowCount: result.rowCount, truncated: result.truncated },
    },
  });

  const date = range.to.toISOString().slice(0, 10);
  return new NextResponse(result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sunleon-${kind}-${context.organization.slug}-${date}.csv"`,
      "Cache-Control": "no-store",
      "X-Export-Rows": String(result.rowCount),
      "X-Export-Truncated": String(result.truncated),
    },
  });
}
