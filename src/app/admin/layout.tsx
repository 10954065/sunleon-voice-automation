import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/server/auth/platform-admin";
import { TenantAccessError } from "@/server/auth/tenant";

export const instant = false;

const ADMIN_NAV = [
  { href: "/admin", label: "Organizations" },
  { href: "/admin/monitoring", label: "Monitoring" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/billing", label: "Billing" },
];

/**
 * Platform console shell. Every admin page also checks requirePlatformAdmin itself — the layout check
 * only keeps the navigation from rendering for anyone else.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformAdmin();
  } catch (error) {
    // Don't reveal that the console exists to anyone who isn't a platform admin.
    if (error instanceof TenantAccessError) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="flex-1 bg-stone-50">
      <nav aria-label="Platform admin" className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-8 py-3">
          <span className="mr-4 text-sm font-semibold text-amber-800">Platform admin</span>
          {ADMIN_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              {item.label}
            </Link>
          ))}
          <Link href="/dashboard" className="ml-auto text-sm text-stone-500 hover:text-stone-700">
            ← Dashboard
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
