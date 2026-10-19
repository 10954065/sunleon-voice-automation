import { z } from "zod";

export const createFaqSourceSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1, "Title is required").max(200),
  question: z.string().trim().min(1, "Question is required").max(500),
  answer: z.string().trim().min(1, "Answer is required").max(4000),
});

export const createManualSourceSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1, "Title is required").max(200),
  content: z.string().trim().min(1, "Content is required").max(20000),
});

export const createUrlSourceSchema = z.object({
  agentId: z.string().min(1),
  url: z.string().trim().url("Enter a valid URL"),
});

export const ALLOWED_FILE_EXTENSIONS = ["pdf", "docx", "txt", "md", "csv"] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export type CreateFaqSourceInput = z.infer<typeof createFaqSourceSchema>;
export type CreateManualSourceInput = z.infer<typeof createManualSourceSchema>;
export type CreateUrlSourceInput = z.infer<typeof createUrlSourceSchema>;
