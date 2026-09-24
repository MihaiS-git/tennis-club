import Link from "next/link";

import { SignUpForm } from "@/components/auth/sign-up-form";
import { AuthShell } from "@/components/auth-form";

export default function SignUpPage() {
  return (
    <AuthShell title="Create your account">
      <SignUpForm />
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have an account? <Link className="font-medium text-foreground underline" href="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}
