"use server";

import { signIn, AuthError } from "@/server/auth/config";

export type SignInResult =
  | { ok: true }
  | { ok: false; error: string };

export async function signInWithCredentials(formData: FormData): Promise<SignInResult> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false, error: "Invalid email or password." };
    }
    throw error;
  }
}
