import { z } from "zod";

import { VOICE_IDS } from "@/lib/voice";

export const createAgentSchema = z.object({
  name: z.string().trim().min(2, "Agent name must be at least 2 characters").max(120),
});

export const updateAgentDraftSchema = z.object({
  instructions: z.string().trim().min(10, "Instructions must be at least 10 characters").max(8000),
  persona: z.string().trim().max(500).optional().or(z.literal("")),
  tone: z.string().trim().max(200).optional().or(z.literal("")),
  greeting: z.string().trim().max(500).optional().or(z.literal("")),
  languages: z.array(z.string().trim().min(2).max(10)).min(1, "Select at least one language"),
  leadCaptureEnabled: z.boolean(),
  voice: z.enum(VOICE_IDS, { message: "Choose a voice from the list" }).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentDraftInput = z.infer<typeof updateAgentDraftSchema>;
