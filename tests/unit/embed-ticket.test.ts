import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmbedTicket, verifyEmbedTicket } from "@/server/voice/embedTicket";

const originalSecret = process.env.AUTH_SECRET;

describe("embed tickets", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-for-embed-tickets";
  });

  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
  });

  it("round-trips a ticket for the same agent", () => {
    const ticket = createEmbedTicket({ agentId: "agent-1", host: "example.com" });
    expect(verifyEmbedTicket(ticket, "agent-1")).toEqual({ host: "example.com" });
  });

  it("rejects a ticket issued for a different agent", () => {
    const ticket = createEmbedTicket({ agentId: "agent-1", host: "example.com" });
    expect(verifyEmbedTicket(ticket, "agent-2")).toBeNull();
  });

  it("rejects an expired ticket", () => {
    const issuedAt = Date.now();
    const ticket = createEmbedTicket({ agentId: "agent-1", host: "example.com", now: issuedAt });
    expect(verifyEmbedTicket(ticket, "agent-1", issuedAt + 11 * 60 * 1000)).toBeNull();
  });

  it("rejects a ticket whose payload was tampered with (e.g. a swapped host)", () => {
    const ticket = createEmbedTicket({ agentId: "agent-1", host: "example.com" });
    const [, signature] = ticket.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ agentId: "agent-1", host: "attacker.net", exp: Date.now() + 60_000 })
    ).toString("base64url");
    expect(verifyEmbedTicket(`${forgedPayload}.${signature}`, "agent-1")).toBeNull();
  });

  it("rejects a ticket signed with a different secret", () => {
    const ticket = createEmbedTicket({ agentId: "agent-1", host: "example.com" });
    process.env.AUTH_SECRET = "a-different-secret";
    expect(verifyEmbedTicket(ticket, "agent-1")).toBeNull();
  });

  it("rejects malformed tickets without throwing", () => {
    expect(verifyEmbedTicket("", "agent-1")).toBeNull();
    expect(verifyEmbedTicket("no-dot-here", "agent-1")).toBeNull();
    expect(verifyEmbedTicket("abc.def", "agent-1")).toBeNull();
  });

  it("refuses to sign without AUTH_SECRET rather than signing with an empty key", () => {
    delete process.env.AUTH_SECRET;
    expect(() => createEmbedTicket({ agentId: "agent-1", host: "example.com" })).toThrow(/AUTH_SECRET/);
  });
});
