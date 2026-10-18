import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/password";

describe("password hashing", () => {
  it("hashes a password to a value different from the plaintext", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).not.toBe("correct-horse-battery-staple");
    expect(hash.length).toBeGreaterThan(20);
  });

  it("verifies a correct password against its hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password against the hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });
});
