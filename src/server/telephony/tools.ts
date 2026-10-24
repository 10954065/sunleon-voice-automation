import "server-only";

import { z } from "zod";

import { prisma } from "@/server/db/client";
import { toE164 } from "@/lib/phone";
import { recordLead, searchKnowledgeForConversation } from "@/server/voice/session";
import type { EmbeddingProvider } from "@/server/knowledge/embeddings";
import { recordOptOut } from "./optOut";
import { PHONE_TOOL } from "./toolDefinitions";
import { requestTransfer } from "./transfer";
import type { TelephonyCarrier } from "./twilio";

export interface PhoneToolResult {
  /** Returned to the model as the function call output. */
  output: string;
  /** The model asked to hang up; the caller of this function ends the AI leg. */
  endCall?: boolean;
  /** The call was redirected to a person; the AI leg is already gone. */
  transferred?: boolean;
}

const searchArgs = z.object({ query: z.string().trim().min(1).max(500) });
const contactArgs = z.object({
  name: z.string().trim().max(200).optional(),
  use_caller_number: z.boolean().optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

function result(payload: Record<string, unknown>, extra: Omit<PhoneToolResult, "output"> = {}): PhoneToolResult {
  return { output: JSON.stringify(payload), ...extra };
}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Runs a tool the AI called during a phone session. Tenant scope comes only from the conversation
 * row; arguments are untrusted model output and are validated like any request body.
 */
export async function executePhoneTool(params: {
  conversationId: string;
  name: string;
  argumentsJson: string;
  carrier?: TelephonyCarrier;
  embeddingProvider?: EmbeddingProvider;
  now?: Date;
}): Promise<PhoneToolResult> {
  const phoneCall = await prisma.phoneCall.findUnique({
    where: { conversationId: params.conversationId },
    select: { organizationId: true, remoteNumber: true },
  });
  if (!phoneCall) {
    return result({ error: "This call is not active." });
  }
  const args = parseArgs(params.argumentsJson);

  switch (params.name) {
    case PHONE_TOOL.searchKnowledge: {
      const parsed = searchArgs.safeParse(args);
      if (!parsed.success) {
        return result({ error: "Provide a short search query." });
      }
      return result(
        await searchKnowledgeForConversation({
          conversationId: params.conversationId,
          query: parsed.data.query,
          embeddingProvider: params.embeddingProvider,
        })
      );
    }
    case PHONE_TOOL.saveContact: {
      const parsed = contactArgs.safeParse(args);
      if (!parsed.success) {
        return result({ error: "Those contact details aren't valid." });
      }
      const { name, use_caller_number: useCallerNumber, phone, email, note } = parsed.data;
      const typedPhone = phone ? toE164(phone) : null;
      if (phone && !typedPhone) {
        return result({ error: "That phone number doesn't look complete. Ask the caller to repeat it." });
      }
      const emailCheck = email ? z.email().safeParse(email) : null;
      if (emailCheck && !emailCheck.success) {
        return result({ error: "That email address doesn't look right. Ask the caller to spell it." });
      }
      const saved = await recordLead({
        conversationId: params.conversationId,
        name,
        phone: typedPhone ?? (useCallerNumber ? (phoneCall.remoteNumber ?? undefined) : undefined),
        email,
        note,
      });
      return saved.ok ? result({ ok: true }) : result({ error: saved.error });
    }
    case PHONE_TOOL.transfer: {
      const transfer = await requestTransfer({
        conversationId: params.conversationId,
        carrier: params.carrier,
        now: params.now,
      });
      return transfer.ok ? result({ ok: true }, { transferred: true }) : result({ error: transfer.error });
    }
    case PHONE_TOOL.optOut: {
      if (!phoneCall.remoteNumber) {
        return result({ error: "The caller's number is withheld, so it can't be added to the do-not-call list." });
      }
      await recordOptOut(prisma, {
        organizationId: phoneCall.organizationId,
        phoneNumber: phoneCall.remoteNumber,
        source: "CALLER_REQUEST",
      });
      return result({ ok: true, message: "This number won't be called by the business again." });
    }
    case PHONE_TOOL.endCall:
      return result({ ok: true }, { endCall: true });
    default:
      return result({ error: `Unknown tool: ${params.name.slice(0, 50)}` });
  }
}
