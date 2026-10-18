import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Organization name must be at least 2 characters").max(120),
});

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(["ADMIN", "AGENT_MANAGER", "ANALYST"]),
});

export const changeRoleSchema = z.object({
  membershipId: z.string().min(1),
  role: z.enum(["OWNER", "ADMIN", "AGENT_MANAGER", "ANALYST"]),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
