import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { registerUser } from "@/server/actions/register";
import { verifyPassword } from "@/lib/password";
import { resetDatabase } from "./helpers";

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return form;
}

describe("registerUser", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("creates a user with a hashed password, not the plaintext", async () => {
    const result = await registerUser(
      formData({ name: "Ama Owusu", email: "ama@example.com", password: "supersecret123" })
    );

    expect(result).toEqual({ ok: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "ama@example.com" } });
    expect(user.passwordHash).not.toBeNull();
    expect(user.passwordHash).not.toBe("supersecret123");
    await expect(verifyPassword("supersecret123", user.passwordHash!)).resolves.toBe(true);
  });

  it("rejects registering the same email twice", async () => {
    await registerUser(
      formData({ name: "Ama Owusu", email: "ama@example.com", password: "supersecret123" })
    );

    const secondAttempt = await registerUser(
      formData({ name: "Someone Else", email: "ama@example.com", password: "differentpassword" })
    );

    expect(secondAttempt.ok).toBe(false);

    const users = await prisma.user.findMany({ where: { email: "ama@example.com" } });
    expect(users).toHaveLength(1);
  });

  it("rejects an invalid email with a field error and no database write", async () => {
    const result = await registerUser(
      formData({ name: "Ama Owusu", email: "not-an-email", password: "supersecret123" })
    );

    expect(result.ok).toBe(false);
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(0);
  });
});
