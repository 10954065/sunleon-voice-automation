import { prisma } from "@/server/db/client";
import { requireOrgContext } from "@/server/auth/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { InviteMemberForm } from "./invite-member-form";

export const instant = false;

export default async function MembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);

  const members = await prisma.membership.findMany({
    where: { organizationId: context.organization.id },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });

  const canManageMembers = context.role === "OWNER" || context.role === "ADMIN";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Members</h1>
        <p className="mt-1 text-sm text-stone-500">
          Invitation emails aren&apos;t sent yet — the person must already have a Sunleon Voice account.
        </p>
      </div>

      <Card>
        <CardContent className="divide-y divide-stone-100 p-0">
          {members.map((member) => (
            <div key={member.id} className="flex items-center justify-between px-6 py-4">
              <div>
                <p className="text-sm font-medium text-stone-950">
                  {member.user.name ?? member.user.email}
                </p>
                <p className="text-xs text-stone-500">{member.user.email}</p>
              </div>
              <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                {member.role}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {canManageMembers ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a member</CardTitle>
            <CardDescription>They need an existing account with this email.</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteMemberForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
