import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to Sunleon Voice.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SignInForm />
        <p className="text-center text-sm text-stone-500">
          Don&apos;t have an account?{" "}
          <Link href="/sign-up" className="font-medium text-amber-700 hover:text-amber-800">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
