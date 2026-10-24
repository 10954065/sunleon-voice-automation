import "server-only";

import type { Db } from "@/server/billing/entitlements";
import type { OptOutSource } from "@/generated/prisma/client";

export async function isOptedOut(db: Db, organizationId: string, phoneNumber: string): Promise<boolean> {
  const entry = await db.callOptOut.findUnique({
    where: { organizationId_phoneNumber: { organizationId, phoneNumber } },
    select: { id: true },
  });
  return entry !== null;
}

/** Adds a number to the organization's do-not-call list. Returns false if it was already there. */
export async function recordOptOut(
  db: Db,
  params: { organizationId: string; phoneNumber: string; source: OptOutSource; createdByUserId?: string | null }
): Promise<boolean> {
  const created = await db.callOptOut.createMany({
    data: [
      {
        organizationId: params.organizationId,
        phoneNumber: params.phoneNumber,
        source: params.source,
        createdByUserId: params.createdByUserId ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return created.count === 1;
}
