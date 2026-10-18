import { describe, expect, it } from "vitest";

import { signUpSchema, signInSchema } from "@/lib/validation/auth";
import { createOrganizationSchema } from "@/lib/validation/organization";

describe("signUpSchema", () => {
  it("accepts a valid sign-up payload", () => {
    const result = signUpSchema.safeParse({
      name: "Ama Owusu",
      email: "Ama@Example.com",
      password: "supersecret123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ama@example.com");
    }
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = signUpSchema.safeParse({
      name: "Ama Owusu",
      email: "ama@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = signUpSchema.safeParse({
      name: "Ama Owusu",
      email: "not-an-email",
      password: "supersecret123",
    });
    expect(result.success).toBe(false);
  });
});

describe("signInSchema", () => {
  it("rejects an empty password", () => {
    const result = signInSchema.safeParse({ email: "ama@example.com", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("createOrganizationSchema", () => {
  it("rejects a name shorter than 2 characters", () => {
    const result = createOrganizationSchema.safeParse({ name: "A" });
    expect(result.success).toBe(false);
  });
});
