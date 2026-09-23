import Link from "next/link";

import { requestPasswordReset } from "@/lib/auth/actions";
import { authErrors, authMessages, readAuthNotice } from "@/lib/auth/messages";

type ForgotPasswordPageProps = {
  searchParams: Promise<{
    error?: string | string[];
    message?: string | string[];
  }>;
};

export default async function ForgotPasswordPage({
  searchParams,
}: ForgotPasswordPageProps) {
  const params = await searchParams;
  const error = readAuthNotice(params.error, authErrors);
  const message = readAuthNotice(params.message, authMessages);

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-md rounded-card border border-border bg-surface-elevated p-8 shadow-card">
        <p className="text-sm font-medium text-accent">Tennis Club</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter your email address and we&apos;ll send a reset link.
        </p>

        {error ? <p className="mt-6 rounded-control bg-danger-background px-4 py-3 text-sm text-danger" role="alert">{error}</p> : null}
        {message ? <p className="mt-6 rounded-control bg-success-background px-4 py-3 text-sm text-success" role="status">{message}</p> : null}

        <form action={requestPasswordReset} className="mt-6">
          <label className="text-sm font-medium" htmlFor="email">Email</label>
          <input autoComplete="email" className="mt-2 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20" id="email" name="email" required type="email" />
          <button className="mt-5 w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover" type="submit">Send reset link</button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link className="font-medium text-primary hover:underline" href="/login">Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}
