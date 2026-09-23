import { redirect } from "next/navigation";

import { SignupForm } from "./signup-form";
import { authErrors, readAuthNotice } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";

type SignupPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (data?.claims.sub) {
    redirect("/account");
  }

  const params = await searchParams;
  const error = readAuthNotice(params.error, authErrors);

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-md rounded-card border border-border bg-surface-elevated p-8 shadow-card">
        <p className="text-sm font-medium text-accent">
          Tennis Club
        </p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-foreground">
          Create an account
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every new account starts with member access.
        </p>

        <SignupForm initialError={error} />
      </section>
    </main>
  );
}
