import "server-only";

import { prisma } from "@/server/db/client";
import type { LeadStatus } from "@/generated/prisma/client";

export const LEADS_PAGE_SIZE = 25;

/** Newest first, keyset-paginated on (createdAt, id) and always scoped to organizationId. */
export async function listLeads(filters: {
  organizationId: string;
  status?: LeadStatus;
  agentId?: string;
  cursor?: string;
}) {
  const rows = await prisma.lead.findMany({
    where: {
      organizationId: filters.organizationId,
      ...(filters.status && { status: filters.status }),
      ...(filters.agentId && { agentId: filters.agentId }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LEADS_PAGE_SIZE + 1,
    ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    include: { agent: { select: { name: true } } },
  });
  const page = rows.slice(0, LEADS_PAGE_SIZE);
  return {
    rows: page,
    nextCursor: rows.length > LEADS_PAGE_SIZE ? page[page.length - 1]?.id ?? null : null,
  };
}
