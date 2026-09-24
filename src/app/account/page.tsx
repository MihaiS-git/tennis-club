import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/auth-action-forms";
import { AuthShell } from "@/components/auth-form";
import { SubmitButton } from "@/components/submit-button";
import { readCurrentAccount } from "@/lib/auth/account";
import { loginPath } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";
import { signOutAction } from "./actions";

export default async function AccountPage() {
  const supabase = await createClient();
  const account = await readCurrentAccount(supabase);

  if (account.state === "unauthenticated") redirect(loginPath("/account"));

  if (account.state === "missing-profile") {
    return (
      <AuthShell
        title="Account unavailable"
        description="Your authenticated account is missing its required application profile. Please contact club support."
      >
        <form action={signOutAction}>
          <SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton>
        </form>
      </AuthShell>
    );
  }

  if (account.state === "load-error") {
    return (
      <AuthShell
        title="Account unavailable"
        description="We couldn't load your account information. Please try again."
      >
        <form action={signOutAction}>
          <SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton>
        </form>
      </AuthShell>
    );
  }

  if (account.state === "suspended") {
    return (
      <AuthShell
        title="Account suspended"
        description="This account is restricted. Contact club support if you believe this is a mistake."
      >
        <form action={signOutAction}>
          <SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Your account" description={account.email}>
      <section aria-labelledby="roles-heading" className="mb-6">
        <h2 id="roles-heading" className="text-sm font-medium text-zinc-700">Roles</h2>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Assigned roles">
          {account.roles.map((role) => (
            <li key={role} className="rounded-full bg-zinc-100 px-3 py-1 text-sm capitalize text-zinc-800">
              {role}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="change-password-heading">
        <h2 id="change-password-heading" className="text-lg font-semibold text-zinc-950">Change password</h2>
        <ChangePasswordForm />
      </section>
      <form action={signOutAction} className="mt-6 border-t border-zinc-200 pt-6">
        <SubmitButton variant="secondary" pendingLabel="Signing out…">Sign out</SubmitButton>
      </form>
    </AuthShell>
  );
}
