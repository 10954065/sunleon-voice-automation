"use server";

import { prisma } from "@/server/db/client";
import { hashPassword } from "@/lib/password";
import { signUpSchema } from "@/lib/validation/auth";

export type RegisterResult =
  | { ok: true }
  | { ok: false; error: string };

export async function registerUser(formData: FormData): Promise<RegisterResult> {
  const parsed = signUpSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true },
  });

  if (existing) {
    return { ok: false, error: "An account with this email already exists." };
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash,
    },
  });

  return { ok: true };
}
