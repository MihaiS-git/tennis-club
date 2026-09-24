import Link from "next/link";

import { SignInForm } from "@/components/auth/sign-in-form";
import { AuthShell } from "@/components/auth-form";

export default function LoginPage() {
  return (
    <AuthShell title="Sign in">
      <SignInForm />
      <div className="mt-4 text-right">
        <Link className="text-sm text-muted-foreground underline" href="/forgot-password">Forgot password?</Link>
      </div>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Need an account? <Link className="font-medium text-foreground underline" href="/signup">Sign up</Link>
      </p>
    </AuthShell>
  );
}
