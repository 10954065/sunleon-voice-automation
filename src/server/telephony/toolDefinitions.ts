import "server-only";

import type { RealtimeFunctionTool } from "openai/resources/realtime/realtime";

import { SEARCH_KNOWLEDGE_TOOL } from "@/server/voice/tools";

export const PHONE_TOOL = {
  searchKnowledge: "search_knowledge",
  saveContact: "save_contact_details",
  transfer: "transfer_to_human",
  optOut: "opt_out_of_calls",
  endCall: "end_call",
} as const;

const SAVE_CONTACT_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: PHONE_TOOL.saveContact,
  description:
    "Save the caller's contact details so the business can follow up. Only call this after the caller " +
    "agrees to be contacted. If they agree to be called back on the number they are calling from, set " +
    "use_caller_number to true instead of asking them to read out digits.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The caller's name." },
      use_caller_number: { type: "boolean", description: "Use the number this call is connected to." },
      phone: { type: "string", description: "A different phone number the caller gave." },
      email: { type: "string", description: "The caller's email address, if they gave one." },
      note: { type: "string", description: "What the caller wants, in a sentence or two." },
    },
  },
};

const TRANSFER_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: PHONE_TOOL.transfer,
  description:
    "Hand the caller to a member of the business's team. Use when the caller asks for a person, or when " +
    "you can't help. Tell the caller you are transferring them before calling this.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Why the caller needs a person, in a few words." } },
  },
};

const OPT_OUT_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: PHONE_TOOL.optOut,
  description:
    "Record that this person does not want to receive calls from the business again. Call this whenever " +
    "they say so, then apologise briefly and end the call.",
  parameters: { type: "object", properties: {} },
};

const END_CALL_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: PHONE_TOOL.endCall,
  description: "Hang up. Only call this after you have said goodbye and the conversation is finished.",
  parameters: { type: "object", properties: {} },
};

/** The tools a phone session gets. Contact capture and transfer only when the business enabled them. */
export function phoneToolsFor(params: { leadCapture: boolean; transferAvailable: boolean }): RealtimeFunctionTool[] {
  const search: RealtimeFunctionTool = {
    type: "function",
    name: SEARCH_KNOWLEDGE_TOOL.name,
    description: SEARCH_KNOWLEDGE_TOOL.description,
    parameters: SEARCH_KNOWLEDGE_TOOL.parameters,
  };
  return [
    search,
    ...(params.leadCapture ? [SAVE_CONTACT_TOOL] : []),
    ...(params.transferAvailable ? [TRANSFER_TOOL] : []),
    OPT_OUT_TOOL,
    END_CALL_TOOL,
  ];
}
