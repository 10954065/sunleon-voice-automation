import { formatDateTime } from "@/lib/format";

type AuditRow = {
  id: string;
  action: string;
  createdAt: Date;
  metadata: unknown;
  actor: { email: string } | null;
  organization: { name: string } | null;
};

const MAX_DETAIL_CHARS = 160;

function details(metadata: unknown): string {
  if (metadata === null || metadata === undefined) {
    return "";
  }
  const text = JSON.stringify(metadata);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/** Read-only audit entries. Metadata never holds contact details (actions record ids and counts only). */
export function AuditTable({ rows, showOrganization }: { rows: AuditRow[]; showOrganization: boolean }) {
  if (rows.length === 0) {
    return <p className="p-6 text-sm text-stone-500">No audit entries match.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 text-xs text-stone-500">
          <tr>
            <th className="px-4 py-2 font-medium">When</th>
            {showOrganization ? <th className="px-4 py-2 font-medium">Organization</th> : null}
            <th className="px-4 py-2 font-medium">Who</th>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-stone-100 align-top">
              <td className="whitespace-nowrap px-4 py-2 text-stone-600">{formatDateTime(row.createdAt)}</td>
              {showOrganization ? (
                <td className="px-4 py-2 text-stone-700">{row.organization?.name ?? "Platform"}</td>
              ) : null}
              <td className="px-4 py-2 text-stone-700">{row.actor?.email ?? "System"}</td>
              <td className="px-4 py-2 font-mono text-xs text-stone-900">{row.action}</td>
              <td className="break-all px-4 py-2 font-mono text-xs text-stone-500">{details(row.metadata)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const AUDIT_ACTION_OPTIONS = [
  { value: "", label: "All actions" },
  { value: "privacy.", label: "Data & privacy" },
  { value: "retention.", label: "Automatic retention" },
  { value: "export.", label: "Exports" },
  { value: "lead.", label: "Leads" },
  { value: "member.", label: "Members" },
  { value: "agent.", label: "Agents" },
  { value: "billing.", label: "Billing" },
  { value: "admin.", label: "Platform admin" },
];
