import Link from "next/link";

import { SignInForm } from "@/components/auth-action-forms";
import { AuthShell } from "@/components/auth-form";
import { safeRedirectPath } from "@/lib/auth/redirects";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);

  return (
    <AuthShell title="Sign in">
      <SignInForm next={next} />
      <div className="mt-4 text-right">
        <Link className="text-sm text-zinc-700 underline" href="/forgot-password">Forgot password?</Link>
      </div>
      <p className="mt-5 text-center text-sm text-zinc-600">
        Need an account? <Link className="font-medium text-zinc-950 underline" href="/signup">Sign up</Link>
      </p>
    </AuthShell>
  );
}

