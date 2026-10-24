import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract tests at the provider boundary: the official SDKs are replaced with recorders, so these
 * prove we call Twilio and OpenAI with the parameters their documentation requires — not that the
 * live services accept them (that needs real credentials; see docs/PHASE_STATUS.md).
 */
const sdk = vi.hoisted(() => {
  const callContext = { update: vi.fn(), fetch: vi.fn() };
  const twilioClient = { calls: Object.assign(vi.fn(() => callContext), { create: vi.fn() }) };
  const openai = {
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    unwrap: vi.fn(),
    constructed: [] as Array<Record<string, unknown>>,
  };
  const sockets: Array<{ props: unknown; socket: EventEmitter; events: EventEmitter; sent: unknown[]; closed: boolean }> = [];
  return { callContext, twilioClient, openai, sockets };
});

vi.mock("twilio", async (importOriginal) => {
  const actual = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  const factory = Object.assign(
    vi.fn(() => sdk.twilioClient),
    { validateRequest: actual.validateRequest, twiml: actual.twiml }
  );
  return { default: factory };
});

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    realtime = { calls: { accept: sdk.openai.accept, reject: sdk.openai.reject, hangup: sdk.openai.hangup } };
    webhooks = { unwrap: sdk.openai.unwrap };
    constructor(options: Record<string, unknown>) {
      sdk.openai.constructed.push(options);
    }
  },
}));

vi.mock("openai/realtime/ws", () => ({
  OpenAIRealtimeWS: class FakeRealtimeWS {
    socket = new EventEmitter();
    private events = new EventEmitter();
    private record: (typeof sdk.sockets)[number];
    constructor(props: unknown) {
      this.record = { props, socket: this.socket, events: this.events, sent: [], closed: false };
      sdk.sockets.push(this.record);
    }
    on(name: string, listener: (...args: unknown[]) => void) {
      this.events.on(name, listener);
    }
    send(event: unknown) {
      this.record.sent.push(event);
    }
    close() {
      this.record.closed = true;
      this.socket.emit("close");
    }
  },
}));

const { TwilioCarrier, MissingCarrierCredentialsError } = await import("@/server/telephony/twilio");
const { OpenAIRealtimeCallControl, parseRealtimeWebhook, InvalidRealtimeWebhookError, MissingRealtimeSipCredentialsError } =
  await import("@/server/telephony/realtimeSip");
const { openSidebandConnection, runSidebandForCall } = await import("@/server/telephony/sideband");

const ENV_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_WEBHOOK_SECRET", "OPENAI_PROJECT_ID"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("provider adapters", () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = `AC${"0".repeat(32)}`;
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_WEBHOOK_SECRET = "whsec_dGVzdA==";
    process.env.OPENAI_PROJECT_ID = "proj_test";
    sdk.openai.constructed.length = 0;
    sdk.sockets.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe("Twilio carrier", () => {
    it("creates outbound calls with status callbacks, a hard time limit and answering-machine detection", async () => {
      sdk.twilioClient.calls.create.mockResolvedValue({ sid: "CA123" });
      const result = await new TwilioCarrier().createCall({
        to: "+233241234567",
        from: "+233302000001",
        answerUrl: "https://voice.example.com/a",
        statusCallbackUrl: "https://voice.example.com/s",
        ringTimeoutSeconds: 30,
        timeLimitSeconds: 330,
      });
      expect(result).toEqual({ callSid: "CA123" });
      expect(sdk.twilioClient.calls.create).toHaveBeenCalledWith({
        to: "+233241234567",
        from: "+233302000001",
        url: "https://voice.example.com/a",
        method: "POST",
        statusCallback: "https://voice.example.com/s",
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        timeout: 30,
        timeLimit: 330,
        machineDetection: "Enable",
      });
    });

    it("redirects live calls with TwiML and reads call records with prices as positive micro-units", async () => {
      sdk.callContext.update.mockResolvedValue({});
      sdk.callContext.fetch.mockResolvedValue({ status: "completed", duration: "42", price: "-0.0130", priceUnit: "USD" });
      const carrier = new TwilioCarrier();

      await carrier.redirectCall("CA123", "<Response/>");
      expect(sdk.twilioClient.calls).toHaveBeenCalledWith("CA123");
      expect(sdk.callContext.update).toHaveBeenCalledWith({ twiml: "<Response/>" });

      expect(await carrier.fetchCall("CA123")).toEqual({ status: "completed", durationSeconds: 42, priceMicros: 13_000, priceUnit: "USD" });
      sdk.callContext.fetch.mockResolvedValue({ status: "in-progress", duration: null, price: null, priceUnit: null });
      expect(await carrier.fetchCall("CA123")).toEqual({ status: "in-progress", durationSeconds: null, priceMicros: null, priceUnit: null });
    });

    it("refuses to call Twilio without credentials", async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      await expect(new TwilioCarrier().fetchCall("CA1")).rejects.toThrow(MissingCarrierCredentialsError);
      expect(sdk.twilioClient.calls.create).not.toHaveBeenCalled();
    });
  });

  describe("OpenAI Realtime SIP", () => {
    it("accepts as a realtime session, declines with SIP 603, and hangs up through the SDK", async () => {
      const control = new OpenAIRealtimeCallControl();
      await control.accept("rtc_1", { model: "gpt-realtime-2", instructions: "Be brief." });
      expect(sdk.openai.accept).toHaveBeenCalledWith("rtc_1", { type: "realtime", model: "gpt-realtime-2", instructions: "Be brief." });
      await control.reject("rtc_2");
      expect(sdk.openai.reject).toHaveBeenCalledWith("rtc_2", { status_code: 603 });
      await control.hangup("rtc_3");
      expect(sdk.openai.hangup).toHaveBeenCalledWith("rtc_3");
      expect(sdk.openai.constructed[0]).toEqual({ apiKey: "sk-test", webhookSecret: "whsec_dGVzdA==" });
    });

    it("unwraps signed webhooks, ignores other event types, and maps signature failures", async () => {
      const headers = new Headers({ "webhook-id": "msg_1" });
      sdk.openai.unwrap.mockResolvedValueOnce({
        id: "evt_1",
        type: "realtime.call.incoming",
        data: { call_id: "rtc_1", sip_headers: [{ name: "X-Sunleon-Conversation", value: "0b8f4c1e-6d2a-4f7b-9c3e-1a2b3c4d5e6f" }] },
      });
      expect(await parseRealtimeWebhook("{}", headers)).toEqual({
        webhookId: "msg_1",
        callId: "rtc_1",
        conversationId: "0b8f4c1e-6d2a-4f7b-9c3e-1a2b3c4d5e6f",
      });
      expect(sdk.openai.unwrap).toHaveBeenCalledWith("{}", headers);

      sdk.openai.unwrap.mockResolvedValueOnce({ id: "evt_2", type: "response.completed", data: {} });
      expect(await parseRealtimeWebhook("{}", headers)).toBeNull();

      sdk.openai.unwrap.mockRejectedValueOnce(new Error("The given webhook signature does not match"));
      await expect(parseRealtimeWebhook("{}", headers)).rejects.toThrow(InvalidRealtimeWebhookError);

      delete process.env.OPENAI_PROJECT_ID;
      await expect(parseRealtimeWebhook("{}", headers)).rejects.toThrow(MissingRealtimeSipCredentialsError);
      await expect(new OpenAIRealtimeCallControl().hangup("rtc_4")).rejects.toThrow(MissingRealtimeSipCredentialsError);
    });

    it("opens the sideband socket for the call and adapts its events", async () => {
      const connection = await openSidebandConnection("rtc_9");
      const record = sdk.sockets[0];
      expect(record.props).toEqual({ callID: "rtc_9" });

      const opened = vi.fn();
      const received = vi.fn();
      const closed = vi.fn();
      connection.onOpen(opened);
      connection.onEvent(received);
      connection.onClose(closed);
      record.socket.emit("open");
      record.events.emit("event", { type: "response.done" });
      connection.send({ type: "response.create" });
      // SDK "error" emissions have a listener, so they never surface as unhandled.
      expect(() => record.events.emit("error", new Error("boom"))).not.toThrow();
      connection.close();

      expect(opened).toHaveBeenCalled();
      expect(received).toHaveBeenCalledWith({ type: "response.done" });
      expect(record.sent).toEqual([{ type: "response.create" }]);
      expect(closed).toHaveBeenCalled();
      expect(record.closed).toBe(true);
    });

    it("won't open a sideband without credentials", async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(openSidebandConnection("rtc_9")).rejects.toThrow(MissingRealtimeSipCredentialsError);
    });

    it("runs a call's sideband until the socket closes", async () => {
      const running = runSidebandForCall({ conversationId: "conv", callId: "rtc_10", maxSeconds: 60 });
      await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1));
      sdk.sockets[0].socket.emit("open");
      expect(sdk.sockets[0].sent).toEqual([{ type: "response.create" }]);
      sdk.sockets[0].socket.emit("close");
      await expect(running).resolves.toBeUndefined();
    });
  });
});
