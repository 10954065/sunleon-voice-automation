import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgContext } from "@/server/auth/session";
import { TenantAccessError } from "@/server/auth/tenant";
import { signOut } from "@/server/auth/config";
import { isPlatformAdmin } from "@/server/auth/platform-admin";

// Tenant-scoped shell: resolves the session and membership on every request.
export const instant = false;

const NAV_ITEMS = [
  { href: "", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/members", label: "Members" },
  { href: "/billing", label: "Billing" },
];

export default async function OrgDashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  let context;
  try {
    context = await requireOrgContext(orgSlug);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }
  const showPlatformAdmin = await isPlatformAdmin(context.user.id);

  return (
    <div className="flex flex-1">
      <aside className="w-64 border-r border-stone-200 bg-white px-4 py-6">
        <p className="mb-1 text-sm font-semibold text-stone-950">{context.organization.name}</p>
        <p className="mb-6 text-xs text-stone-500">Signed in as {context.user.email} · {context.role}</p>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              href={`/dashboard/${orgSlug}${item.href}`}
              className="block rounded-md px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              {item.label}
            </Link>
          ))}
          {showPlatformAdmin ? (
            <Link
              href="/admin/billing"
              className="block rounded-md px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50"
            >
              Platform admin
            </Link>
          ) : null}
        </nav>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
          className="mt-6"
        >
          <button
            type="submit"
            className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-stone-500 hover:bg-stone-100"
          >
            Sign out
          </button>
        </form>
      </aside>
      <main className="flex-1 bg-stone-50 px-8 py-8">{children}</main>
    </div>
  );
}
