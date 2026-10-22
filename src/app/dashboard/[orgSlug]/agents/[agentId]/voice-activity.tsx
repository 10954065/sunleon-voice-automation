import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ConversationRow = {
  id: string;
  channel: "TEST" | "EMBED";
  status: "ACTIVE" | "COMPLETED" | "FAILED";
  originDomain: string | null;
  startedAt: string;
  endedAt: string | null;
  closeReason: string | null;
  errorMessage: string | null;
};

type LeadRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  createdAt: string;
};

const STATUS_STYLES: Record<ConversationRow["status"], string> = {
  ACTIVE: "bg-sky-100 text-sky-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-red-100 text-red-800",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function durationLabel(row: ConversationRow): string {
  if (!row.endedAt) {
    return "—";
  }
  const seconds = Math.max(0, Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function VoiceActivity({ conversations, leads }: { conversations: ConversationRow[]; leads: LeadRow[] }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Recent voice sessions</CardTitle>
          <CardDescription>
            The last 10 sessions for this agent. Duration is wall-clock time on our server, not billed provider time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {conversations.length === 0 ? (
            <p className="text-sm text-stone-500">No voice sessions yet.</p>
          ) : (
            <ul className="divide-y divide-stone-200">
              {conversations.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                  <div className="space-y-0.5">
                    <p className="text-stone-900">
                      {row.channel === "TEST" ? "Dashboard test" : `Website · ${row.originDomain ?? "unknown site"}`}
                    </p>
                    <p className="text-xs text-stone-500">
                      {formatDate(row.startedAt)} · {durationLabel(row)}
                      {row.closeReason ? ` · ${row.closeReason.replace(/_/g, " ")}` : ""}
                    </p>
                    {row.errorMessage ? <p className="text-xs text-red-700">{row.errorMessage}</p> : null}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                    {row.status.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leads</CardTitle>
          <CardDescription>Contact details visitors chose to share during voice sessions.</CardDescription>
        </CardHeader>
        <CardContent>
          {leads.length === 0 ? (
            <p className="text-sm text-stone-500">No leads captured yet.</p>
          ) : (
            <ul className="divide-y divide-stone-200">
              {leads.map((lead) => (
                <li key={lead.id} className="space-y-0.5 py-3 text-sm">
                  <p className="font-medium text-stone-900">{lead.name || "Unnamed visitor"}</p>
                  <p className="text-stone-700">{[lead.phone, lead.email].filter(Boolean).join(" · ") || "—"}</p>
                  {lead.note ? <p className="text-stone-600">{lead.note}</p> : null}
                  <p className="text-xs text-stone-500">{formatDate(lead.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
