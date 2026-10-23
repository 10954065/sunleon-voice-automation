import "server-only";

import { prisma } from "@/server/db/client";

/** Below this many digits a phone search would match far too broadly. */
export const MIN_PHONE_DIGITS = 7;

/**
 * Reduces a phone number to the digits that identify it regardless of how it was typed: "+233 24 123 4567",
 * "0241234567" and "233241234567" all become "241234567". Returns null when too short to match safely.
 */
export function normalizePhoneDigits(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("233")) {
    digits = digits.slice(3);
  }
  digits = digits.replace(/^0+/, "");
  return digits.length >= MIN_PHONE_DIGITS ? digits : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export interface ErasureResult {
  leadsDeleted: number;
  transcriptsDeleted: number;
}

/**
 * Erases one person's contact data from an organization (a data-subject deletion request): leads whose
 * email or phone matches, and the stored transcripts of those leads' conversations or of any conversation
 * whose transcript contains the email address. Conversation records themselves hold no contact details
 * and stay, so analytics remain accurate. Everything is scoped to organizationId.
 */
export async function eraseContactData(params: {
  organizationId: string;
  email?: string | null;
  phone?: string | null;
}): Promise<ErasureResult> {
  const email = params.email?.trim().toLowerCase() || null;
  const phoneDigits = params.phone ? normalizePhoneDigits(params.phone) : null;
  if (!email && !phoneDigits) {
    return { leadsDeleted: 0, transcriptsDeleted: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const byEmail = email
      ? await tx.lead.findMany({
          where: { organizationId: params.organizationId, email: { equals: email, mode: "insensitive" } },
          select: { id: true, conversationId: true },
        })
      : [];
    const byPhone = phoneDigits
      ? await tx.$queryRaw<Array<{ id: string; conversationId: string | null }>>`
          SELECT "id", "conversationId" FROM "Lead"
          WHERE "organizationId" = ${params.organizationId}
            AND "phone" IS NOT NULL
            AND right(regexp_replace("phone", '\\D', '', 'g'), ${phoneDigits.length}) = ${phoneDigits}`
      : [];

    const leads = [...byEmail, ...byPhone];
    const leadIds = [...new Set(leads.map((lead) => lead.id))];
    const conversationIds = [...new Set(leads.flatMap((lead) => (lead.conversationId ? [lead.conversationId] : [])))];

    const mentioningEmail = email
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ConversationTranscript"
          WHERE "organizationId" = ${params.organizationId}
            AND "entries"::text ILIKE ${`%${escapeLike(email)}%`}`
      : [];

    const transcripts = await tx.conversationTranscript.deleteMany({
      where: {
        organizationId: params.organizationId,
        OR: [{ conversationId: { in: conversationIds } }, { id: { in: mentioningEmail.map((row) => row.id) } }],
      },
    });
    const deletedLeads = await tx.lead.deleteMany({
      where: { organizationId: params.organizationId, id: { in: leadIds } },
    });
    return { leadsDeleted: deletedLeads.count, transcriptsDeleted: transcripts.count };
  });
}
