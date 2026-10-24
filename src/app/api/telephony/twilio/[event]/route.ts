import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getPublicBaseUrl, getTwilioCredentials } from "@/server/telephony/config";
import {
  handleAiDialResult,
  handleCallStatus,
  handleInboundCall,
  handleOutboundAnswer,
  handleOutboundKeypad,
  handleTransferResult,
  type TwilioForm,
} from "@/server/telephony/lifecycle";
import { verifyTwilioSignature } from "@/server/telephony/twilio";
import { sayAndHangUpTwiml } from "@/server/telephony/twiml";
import { reportError } from "@/server/observability/errors";

/** Twilio's form posts are a few KB; anything far larger isn't a real callback. */
const MAX_BODY_BYTES = 64 * 1024;
const XML_HEADERS = { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" };
const conversationIdSchema = z.string().uuid();

const TWIML_EVENTS = new Set(["voice", "outbound-answer", "outbound-keypad", "ai-dial-result", "transfer-result"]);
const NEEDS_CONVERSATION = new Set(["outbound-answer", "outbound-keypad", "ai-dial-result"]);

function xml(twiml: string) {
  return new NextResponse(twiml, { status: 200, headers: XML_HEADERS });
}

/**
 * Every Twilio webhook for our numbers. Unauthenticated by design: Twilio's X-Twilio-Signature over
 * the exact URL and the form fields is the authentication, checked against our configured public
 * origin (never the Host header), and the account in the payload must be ours. Nothing is read or
 * written before both checks pass.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!TWIML_EVENTS.has(event) && event !== "status") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const credentials = getTwilioCredentials();
  const baseUrl = getPublicBaseUrl();
  if (!credentials || !baseUrl) {
    return NextResponse.json({ error: "Telephony is not configured." }, { status: 503 });
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  const form: TwilioForm = Object.fromEntries(new URLSearchParams(raw));
  const signedUrl = `${baseUrl}${request.nextUrl.pathname}${request.nextUrl.search}`;
  const signatureValid = verifyTwilioSignature({
    authToken: credentials.authToken,
    signature: request.headers.get("x-twilio-signature"),
    url: signedUrl,
    form,
  });
  if (!signatureValid || form.AccountSid !== credentials.accountSid) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }
  if (!form.CallSid) {
    return NextResponse.json({ error: "Missing CallSid." }, { status: 400 });
  }

  const conversationParam = request.nextUrl.searchParams.get("conversation");
  const conversation = conversationParam ? conversationIdSchema.safeParse(conversationParam) : null;
  if ((NEEDS_CONVERSATION.has(event) || conversationParam) && !conversation?.success) {
    return NextResponse.json({ error: "Invalid conversation." }, { status: 400 });
  }
  const conversationId = conversation?.success ? conversation.data : null;

  try {
    switch (event) {
      case "status":
        return NextResponse.json({ result: await handleCallStatus(form) }, { headers: { "Cache-Control": "no-store" } });
      case "voice":
        return xml(await handleInboundCall(form));
      case "outbound-answer":
        return xml(await handleOutboundAnswer(conversationId as string, form));
      case "outbound-keypad":
        return xml(await handleOutboundKeypad(conversationId as string, form));
      case "ai-dial-result":
        return xml(await handleAiDialResult(conversationId as string, form));
      default:
        return xml(await handleTransferResult(conversationId, form));
    }
  } catch (error) {
    await reportError(error, { source: "route", route: `/api/telephony/twilio/${event}` });
    // A caller on the line still gets a spoken answer; a failed status callback answers 500.
    return event === "status"
      ? NextResponse.json({ error: "Failed." }, { status: 500 })
      : xml(sayAndHangUpTwiml("Sorry, something went wrong. Please try again later. Goodbye."));
  }
}
