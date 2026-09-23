import Link from "next/link";

import { SignUpForm } from "@/components/auth-action-forms";
import { AuthShell } from "@/components/auth-form";

export default function SignUpPage() {
  return (
    <AuthShell title="Create your account">
      <SignUpForm />
      <p className="mt-5 text-center text-sm text-zinc-600">
        Already have an account? <Link className="font-medium text-zinc-950 underline" href="/login">Sign in</Link>
      </p>
    </AuthShell>
  );
}

