import { redirect } from "next/navigation";

import { requireCurrentUser } from "@/server/auth/session";
import { prisma } from "@/server/db/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { CreateOrganizationForm } from "./create-organization-form";

// Reads the session and the user's memberships on every request — never prerenderable.
export const instant = false;

export default async function OnboardingPage() {
  const user = await requireCurrentUser();

  const existingMembership = await prisma.membership.findFirst({
    where: { userId: user.id },
    include: { organization: true },
  });

  if (existingMembership) {
    redirect(`/dashboard/${existingMembership.organization.slug}`);
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-stone-50 px-6 py-16">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Create your workspace</CardTitle>
            <CardDescription>
              This becomes your organization in Sunleon Voice. You can invite teammates afterward.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateOrganizationForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
