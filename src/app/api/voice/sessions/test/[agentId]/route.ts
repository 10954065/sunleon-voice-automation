import { NextRequest, NextResponse } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { requireRole, TenantAccessError } from "@/server/auth/tenant";
import { prepareTestVoiceSession, VoiceSessionError } from "@/server/voice/session";
import { MissingVoiceCredentialsError } from "@/server/voice/provider";
import { prepareTestSessionSchema } from "@/lib/validation/voice";

/**
 * Step 1 of a dashboard test call. The org slug from the query string is never trusted on
 * its own — requireOrgContext resolves it against the signed-in user's Membership row.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const orgSlug = request.nextUrl.searchParams.get("org");
  if (!orgSlug) {
    return NextResponse.json({ error: "Missing organization." }, { status: 400 });
  }

  try {
    const context = await requireOrgContext(orgSlug);
    requireRole(context.role, ["OWNER", "ADMIN", "AGENT_MANAGER"]);

    const body = prepareTestSessionSchema.safeParse(await request.json().catch(() => ({})));
    const prepared = await prepareTestVoiceSession({
      organizationId: context.organization.id,
      organizationName: context.organization.name,
      agentId,
      transcriptConsent: body.success ? body.data.transcriptConsent : false,
    });
    return NextResponse.json(prepared);
  } catch (error) {
    if (error instanceof TenantAccessError || error instanceof VoiceSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof MissingVoiceCredentialsError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
