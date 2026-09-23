import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth-action-forms";
import { AuthShell } from "@/components/auth-form";

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Forgot password" description="Enter your email and we will send password reset instructions.">
      <ForgotPasswordForm />
      <p className="mt-5 text-center text-sm"><Link className="text-zinc-700 underline" href="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}

