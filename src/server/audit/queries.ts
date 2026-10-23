import "server-only";

import { prisma } from "@/server/db/client";

export const AUDIT_PAGE_SIZE = 50;

/**
 * Newest first, keyset-paginated. `organizationId` scopes to one tenant; the platform console passes
 * `null` for every organization's entries plus platform-level ones. Callers authorize before calling.
 */
export async function listAuditLogs(filters: {
  organizationId: string | null;
  actionPrefix?: string;
  cursor?: string;
}) {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(filters.organizationId !== null && { organizationId: filters.organizationId }),
      ...(filters.actionPrefix && { action: { startsWith: filters.actionPrefix } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_PAGE_SIZE + 1,
    ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    include: {
      actor: { select: { email: true } },
      organization: { select: { name: true, slug: true } },
    },
  });
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  return {
    rows: page,
    nextCursor: rows.length > AUDIT_PAGE_SIZE ? page[page.length - 1]?.id ?? null : null,
  };
}
