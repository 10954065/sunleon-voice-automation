import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Then create a workspace for your business.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SignUpForm />
        <p className="text-center text-sm text-stone-500">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-amber-700 hover:text-amber-800">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
