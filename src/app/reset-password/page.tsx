import { redirect } from "next/navigation";

import { PasswordInput } from "@/components/password-input";
import { updatePassword } from "@/lib/auth/actions";
import { authErrors, readAuthNotice } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";

type ResetPasswordPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims.sub) {
    redirect("/login?error=reset-link-invalid");
  }

  const params = await searchParams;
  const error = readAuthNotice(params.error, authErrors);

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-md rounded-card border border-border bg-surface-elevated p-8 shadow-card">
        <p className="text-sm font-medium text-accent">Tennis Club</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-2 text-sm text-muted-foreground">Use 8 to 72 characters.</p>

        {error ? <p className="mt-6 rounded-control bg-danger-background px-4 py-3 text-sm text-danger" role="alert">{error}</p> : null}

        <form action={updatePassword} className="mt-6 space-y-5">
          <div>
            <label className="text-sm font-medium" htmlFor="password">New password</label>
            <PasswordInput autoComplete="new-password" containerClassName="mt-2" id="password" maxLength={72} minLength={8} name="password" required />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="confirmPassword">Confirm new password</label>
            <PasswordInput autoComplete="new-password" containerClassName="mt-2" id="confirmPassword" maxLength={72} minLength={8} name="confirmPassword" required />
          </div>
          <button className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover" type="submit">Update password</button>
        </form>
      </section>
    </main>
  );
}
