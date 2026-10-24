import Link from "next/link";

import { requireOrgContext } from "@/server/auth/session";
import { getPhoneOverview } from "@/server/telephony/queries";
import { OUTCOME_LABELS } from "@/server/conversations/outcome";
import { formatDateTime, formatDuration } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddOptOutForm, NumberSettingsForm, OutboundCallForm, RemoveOptOutForm } from "./phone-forms";

export const instant = false;

const OPT_OUT_SOURCE_LABELS = {
  CALLER_KEYPAD: "Pressed 9 on a call",
  CALLER_REQUEST: "Asked the agent",
  STAFF: "Added by staff",
} as const;

const TRANSFER_LABELS = {
  REQUESTED: "Transfer started",
  CONNECTED: "Transferred, answered",
  MISSED: "Transfer not answered — call back",
} as const;

export default async function PhonePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const context = await requireOrgContext(orgSlug);
  const isAdmin = context.role === "OWNER" || context.role === "ADMIN";
  const canCall = isAdmin || context.role === "AGENT_MANAGER";
  const overview = await getPhoneOverview(context.organization.id);
  const { readiness } = overview;
  const ready = readiness.twilio && readiness.realtimeSip && readiness.publicUrl;
  const outboundNumbers = overview.numbers.filter((number) => number.outboundEnabled && number.agentId);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-950">Phone</h1>
        <p className="mt-1 text-sm text-stone-500">
          Your agents can answer calls to your numbers and call back people who asked to be contacted. Every call starts
          by saying it is an AI assistant. Calls last at most 4½ minutes.
        </p>
      </div>

      {!ready ? (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Phone calling isn&apos;t live on this platform yet:{" "}
          {[
            !readiness.twilio && "the Twilio account isn't connected",
            !readiness.realtimeSip && "the OpenAI phone connection isn't set up",
            !readiness.publicUrl && "the app's public address isn't set",
          ]
            .filter(Boolean)
            .join("; ")}
          . Settings below are saved and take effect once it is.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Your numbers</CardTitle>
          <CardDescription>
            Numbers are provided by the platform team. Calls the agent can&apos;t take (no plan minutes left, the agent is
            unavailable) go to the transfer line if you set one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {overview.numbers.length === 0 ? (
            <p className="text-sm text-stone-500">No phone number yet. Contact support to get a Ghana number.</p>
          ) : (
            overview.numbers.map((number) => (
              <div key={number.id} className="space-y-3 border-b border-stone-100 pb-6 last:border-0 last:pb-0">
                <p className="font-medium text-stone-900">
                  {number.e164}
                  {number.label ? <span className="ml-2 text-sm font-normal text-stone-500">{number.label}</span> : null}
                </p>
                <NumberSettingsForm
                  orgSlug={orgSlug}
                  number={{
                    id: number.id,
                    agentId: number.agentId,
                    transferNumber: number.transferNumber,
                    inboundEnabled: number.inboundEnabled,
                    outboundEnabled: number.outboundEnabled,
                  }}
                  agents={overview.agents}
                  canEdit={isAdmin}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {canCall ? (
        <Card>
          <CardHeader>
            <CardTitle>Call someone back</CardTitle>
            <CardDescription>
              Only call people who asked to be contacted. The person hears who is calling and can press 9 to stop future
              calls. Calls are placed 08:00–20:00 Ghana time, at most 20 an hour, never to numbers on your do-not-call
              list, and each one is recorded in the audit log.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {outboundNumbers.length === 0 ? (
              <p className="text-sm text-stone-500">
                Turn on outbound calls and assign an agent to one of your numbers first.
              </p>
            ) : (
              <OutboundCallForm
                orgSlug={orgSlug}
                numbers={outboundNumbers.map((number) => ({ id: number.id, label: number.label ?? number.e164 }))}
                leads={overview.leads.map((lead) => ({
                  id: lead.id,
                  label: `${lead.name ?? "Unnamed"} · ${lead.phone} · ${formatDateTime(lead.createdAt)}`,
                }))}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>
            Numbers are partly hidden. Times are UTC (Ghana time). Carrier time is the whole call; AI time is what your
            plan counts.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {overview.calls.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No calls yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-stone-200 text-xs uppercase text-stone-500">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Direction</th>
                  <th className="px-4 py-2 font-medium">Number</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">AI time</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {overview.calls.map((call) => (
                  <tr key={call.id}>
                    <td className="px-4 py-2">
                      <Link
                        href={`/dashboard/${orgSlug}/conversations/${call.conversationId}`}
                        className="text-stone-900 hover:underline"
                      >
                        {formatDateTime(call.createdAt)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-stone-700">{call.direction === "INBOUND" ? "Incoming" : "Outgoing"}</td>
                    <td className="px-4 py-2 text-stone-700">{call.remote}</td>
                    <td className="px-4 py-2 text-stone-700">
                      {call.providerStatus}
                      {call.transferStatus ? ` · ${TRANSFER_LABELS[call.transferStatus]}` : ""}
                    </td>
                    <td className="px-4 py-2 text-stone-700">
                      {call.aiLegSeconds != null ? formatDuration(call.aiLegSeconds) : "—"}
                    </td>
                    <td className="px-4 py-2 text-stone-700">
                      {call.outcome ? OUTCOME_LABELS[call.outcome] : "In progress"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Do-not-call list</CardTitle>
          <CardDescription>
            Numbers here are never called. People are added when they press 9, ask the agent, or you add them. The list is
            kept even when someone&apos;s data is erased, so they aren&apos;t called again. Only the owner can remove an
            entry, and only if the person asked.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canCall ? <AddOptOutForm orgSlug={orgSlug} /> : null}
          {overview.optOuts.length === 0 ? (
            <p className="text-sm text-stone-500">No numbers on the list.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {overview.optOuts.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-stone-900">
                    {entry.phone}
                    <span className="ml-2 text-xs text-stone-500">
                      {OPT_OUT_SOURCE_LABELS[entry.source]} · {formatDateTime(entry.createdAt)}
                    </span>
                  </span>
                  {context.role === "OWNER" ? <RemoveOptOutForm orgSlug={orgSlug} optOutId={entry.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
