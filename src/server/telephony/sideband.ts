import "server-only";

import { prisma } from "@/server/db/client";
import { reportError, scrubSensitiveText } from "@/server/observability/errors";
import { getRealtimeSipConfig } from "./config";
import { getRealtimeCallControl, MissingRealtimeSipCredentialsError, type RealtimeCallControl } from "./realtimeSip";
import { executePhoneTool, type PhoneToolResult } from "./tools";

/** Time for the AI's goodbye to finish playing before the call is hung up. */
const END_CALL_DELAY_MS = 3_000;
/** Slack after the reservation before the control connection gives up on its own. */
const SIDEBAND_GRACE_MS = 20_000;
const MAX_LOGGED_ERRORS = 5;

/** A server event as received; only `type` and the function-call fields are read. */
export interface SidebandServerEvent {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
}

/** The slice of the realtime WebSocket the loop needs. The OpenAI SDK socket implements it; tests fake it. */
export interface SidebandConnection {
  send(event: Record<string, unknown>): void;
  close(): void;
  onOpen(listener: () => void): void;
  onEvent(listener: (event: SidebandServerEvent) => void): void;
  onClose(listener: () => void): void;
}

export interface SidebandDeps {
  executeTool?: (params: { conversationId: string; name: string; argumentsJson: string }) => Promise<PhoneToolResult>;
  callControl?: RealtimeCallControl;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function recordSidebandError(conversationId: string, message: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { organizationId: true, agentId: true },
  });
  if (!conversation) {
    return;
  }
  await prisma.usageEvent.create({
    data: {
      organizationId: conversation.organizationId,
      agentId: conversation.agentId,
      conversationId,
      type: "ERROR",
      metadata: { stage: "sideband", message: scrubSensitiveText(message).slice(0, 300) },
    },
  });
}

/**
 * Drives one accepted call over its sideband connection: asks the AI to greet the caller, runs the
 * tools it calls (tenant scope from the conversation row), and hangs up when it asks to. Resolves
 * when the connection closes or the reservation runs out. If this connection fails the call itself
 * carries on (audio is between Twilio and OpenAI) — only tools stop working; that is recorded.
 */
export async function runSideband(params: {
  conversationId: string;
  callId: string;
  connection: SidebandConnection;
  maxSeconds: number;
  deps?: SidebandDeps;
}): Promise<void> {
  const { conversationId, callId, connection } = params;
  const executeTool = params.deps?.executeTool ?? executePhoneTool;
  const sleep = params.deps?.sleep ?? defaultSleep;
  const control = () => params.deps?.callControl ?? getRealtimeCallControl();
  let loggedErrors = 0;

  await new Promise<void>((resolve) => {
    let finished = false;
    const deadline = setTimeout(() => connection.close(), params.maxSeconds * 1000 + SIDEBAND_GRACE_MS);
    const finish = () => {
      if (!finished) {
        finished = true;
        clearTimeout(deadline);
        resolve();
      }
    };

    connection.onClose(finish);
    connection.onOpen(() => connection.send({ type: "response.create" }));
    connection.onEvent((event) => {
      if (event.type === "error" && loggedErrors < MAX_LOGGED_ERRORS) {
        loggedErrors += 1;
        void recordSidebandError(conversationId, event.error?.message ?? "Realtime error event.");
        return;
      }
      if (event.type !== "response.function_call_arguments.done" || !event.call_id || !event.name) {
        return;
      }
      const toolCallId = event.call_id;
      void (async () => {
        try {
          const result = await executeTool({
            conversationId,
            name: event.name as string,
            argumentsJson: event.arguments ?? "",
          });
          if (result.transferred) {
            // Twilio has already moved the caller to the human line; the AI leg is ending.
            connection.close();
            return;
          }
          connection.send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: toolCallId, output: result.output },
          });
          if (result.endCall) {
            await sleep(END_CALL_DELAY_MS);
            await control().hangup(callId);
            connection.close();
            return;
          }
          connection.send({ type: "response.create" });
        } catch (error) {
          await reportError(error, { source: "route", route: "telephony:sideband:tool" });
          connection.send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: toolCallId, output: JSON.stringify({ error: "Tool failed." }) },
          });
          connection.send({ type: "response.create" });
        }
      })();
    });
  });
}

/** Opens the real sideband WebSocket for a call with the official SDK (wss://api.openai.com/v1/realtime?call_id=…). */
export async function openSidebandConnection(callId: string): Promise<SidebandConnection> {
  const config = getRealtimeSipConfig();
  if (!config) {
    throw new MissingRealtimeSipCredentialsError();
  }
  const [{ default: OpenAI }, { OpenAIRealtimeWS }] = await Promise.all([
    import("openai"),
    import("openai/realtime/ws"),
  ]);
  const socket = new OpenAIRealtimeWS({ callID: callId }, new OpenAI({ apiKey: config.apiKey }));
  // Transport and API errors also arrive as "error" events (recorded by runSideband); this listener
  // only stops the SDK treating them as unhandled.
  socket.on("error", () => undefined);
  return {
    send: (event) => socket.send(event as unknown as Parameters<typeof socket.send>[0]),
    close: () => socket.close(),
    onOpen: (listener) => socket.socket.on("open", listener),
    onEvent: (listener) => socket.on("event", (event) => listener(event as unknown as SidebandServerEvent)),
    onClose: (listener) => socket.socket.on("close", listener),
  };
}

/** Entry point used after a call is accepted (inside the webhook's after() callback). */
export async function runSidebandForCall(params: { conversationId: string; callId: string; maxSeconds: number }): Promise<void> {
  try {
    const connection = await openSidebandConnection(params.callId);
    await runSideband({ ...params, connection });
  } catch (error) {
    await recordSidebandError(params.conversationId, error instanceof Error ? error.message : "Sideband failed.");
    await reportError(error, { source: "route", route: "telephony:sideband" });
  }
}
