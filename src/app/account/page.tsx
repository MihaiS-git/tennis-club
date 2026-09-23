import { redirect } from "next/navigation";

import { PasswordInput } from "@/components/password-input";
import { changePassword, signOut } from "@/lib/auth/actions";
import { authErrors, authMessages, readAuthNotice } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";

type AccountPageProps = {
  searchParams: Promise<{
    error?: string | string[];
    message?: string | string[];
  }>;
};

export default async function AccountPage({ searchParams }: AccountPageProps) {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims.sub) {
    redirect("/login");
  }

  const { data: account, error: accountError } = await supabase
    .from("users")
    .select("email, status, created_at")
    .eq("id", claimsData.claims.sub)
    .maybeSingle();

  if (accountError) {
    console.error("Failed to load the authenticated application account", {
      code: accountError.code,
    });
  }

  const params = await searchParams;
  const error = readAuthNotice(params.error, authErrors);
  const message = readAuthNotice(params.message, authMessages);

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-2xl rounded-card border border-border bg-surface-elevated p-8 shadow-card">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-accent">
              Tennis Club
            </p>
            <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-foreground">
              Your account
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This page is available only to authenticated users.
            </p>
          </div>
          <form action={signOut}>
            <button
              className="rounded-control border border-border-strong bg-transparent px-4 py-2 text-sm font-medium text-primary transition hover:bg-surface-muted"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </div>

        {error ? (
          <p
            className="mt-6 rounded-control bg-danger-background px-4 py-3 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {message ? (
          <p
            className="mt-6 rounded-control bg-success-background px-4 py-3 text-sm text-success"
            role="status"
          >
            {message}
          </p>
        ) : null}

        <dl className="mt-8 grid gap-5 rounded-card bg-surface-muted p-5 text-sm">
          <div>
            <dt className="font-medium text-muted-foreground">
              Email
            </dt>
            <dd className="mt-1 break-all">
              {account?.email ?? claimsData.claims.email ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">
              Account status
            </dt>
            <dd className="mt-1 capitalize">{account?.status ?? "Unavailable"}</dd>
          </div>
        </dl>

        {!account && !accountError ? (
          <p className="mt-5 text-sm text-warning">
            Your authenticated identity exists, but the application profile is
            not available yet.
          </p>
        ) : null}

        <section className="mt-8 border-t border-border pt-8">
          <h2 className="font-heading text-xl font-semibold">Change password</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Confirm your current password before choosing a new one.
          </p>
          <form action={changePassword} className="mt-5 space-y-5">
            <div>
              <label className="text-sm font-medium" htmlFor="currentPassword">
                Current password
              </label>
              <PasswordInput
                autoComplete="current-password"
                containerClassName="mt-2"
                id="currentPassword"
                name="currentPassword"
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="newPassword">
                New password
              </label>
              <PasswordInput
                autoComplete="new-password"
                containerClassName="mt-2"
                id="newPassword"
                maxLength={72}
                minLength={8}
                name="password"
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="confirmPassword">
                Confirm new password
              </label>
              <PasswordInput
                autoComplete="new-password"
                containerClassName="mt-2"
                id="confirmPassword"
                maxLength={72}
                minLength={8}
                name="confirmPassword"
                required
              />
            </div>
            <button
              className="rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
              type="submit"
            >
              Change password
            </button>
          </form>
        </section>
      </section>
    </main>
  );
}
