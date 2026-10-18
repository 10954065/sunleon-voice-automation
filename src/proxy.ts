import { NextResponse } from "next/server";

import { auth } from "@/server/auth/config";

const PROTECTED_PREFIXES = ["/dashboard", "/onboarding"];

export default auth((req) => {
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    req.nextUrl.pathname.startsWith(prefix)
  );

  if (isProtected && !req.auth) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding/:path*"],
};
