import { NextRequest, NextResponse } from "next/server";

import { recordLead } from "@/server/voice/session";
import { captureLeadSchema } from "@/lib/validation/voice";
import { isRateLimited } from "@/server/voice/rateLimit";

/**
 * Called by the widget's lead-capture form, a UI affordance rather than an AI tool call —
 * the visitor explicitly submits their own contact details, the model does not decide to
 * invoke this on their behalf. See docs/DECISIONS.md for that scope choice. Public by
 * design; tenant scoping comes entirely from conversationId.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = captureLeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  }

  if (isRateLimited(`lead:${parsed.data.conversationId}`, 5)) {
    return NextResponse.json({ ok: false, error: "Too many submissions." }, { status: 429 });
  }

  const result = await recordLead(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
