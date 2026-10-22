import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const TICKET_TTL_MS = 10 * 60 * 1000;
const DOMAIN_SEPARATOR = "sunleon-voice-embed-ticket:v1:";

interface EmbedTicketPayload {
  agentId: string;
  host: string;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set; cannot sign embed tickets.");
  }
  return secret;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getSecret())
    .update(DOMAIN_SEPARATOR + encodedPayload)
    .digest("base64url");
}

/**
 * Issued by the widget page only after its own request's Referer (set by the visitor's
 * browser, which the embedding page cannot forge) matched the agent's allowlist. The
 * session API then requires this ticket, so a page on a non-allowed site can render the
 * iframe but can never start a session. A non-browser client can forge Referer, so this
 * is a browser-embedding control, not a defense against direct API abuse — rate limits
 * and Phase 4 quotas cover that. See docs/SECURITY_MODEL.md.
 */
export function createEmbedTicket(params: { agentId: string; host: string; now?: number }): string {
  const payload: EmbedTicketPayload = {
    agentId: params.agentId,
    host: params.host,
    exp: (params.now ?? Date.now()) + TICKET_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyEmbedTicket(
  ticket: string,
  expectedAgentId: string,
  now: number = Date.now()
): { host: string } | null {
  const [encoded, signature] = ticket.split(".");
  if (!encoded || !signature) {
    return null;
  }

  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload: EmbedTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (payload.agentId !== expectedAgentId || typeof payload.host !== "string" || payload.exp < now) {
    return null;
  }

  return { host: payload.host };
}
