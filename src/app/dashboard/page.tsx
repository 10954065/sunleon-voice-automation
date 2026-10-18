import { redirect } from "next/navigation";

import { requireCurrentUser } from "@/server/auth/session";
import { prisma } from "@/server/db/client";

// This route reads the session on every request to route to the right org — it can never
// be prerendered as static. See https://nextjs.org/docs/messages/blocking-prerender-runtime
export const instant = false;

export default async function DashboardRootPage() {
  const user = await requireCurrentUser();

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    include: { organization: true },
  });

  redirect(membership ? `/dashboard/${membership.organization.slug}` : "/onboarding");
}
