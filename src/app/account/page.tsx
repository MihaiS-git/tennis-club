import { redirect } from "next/navigation";

import { signOut } from "@/lib/auth/actions";
import { authErrors, readAuthNotice } from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";

type AccountPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
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

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <section className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Tennis Club
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Your account
            </h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              This page is available only to authenticated users.
            </p>
          </div>
          <form action={signOut}>
            <button
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-700 dark:border-zinc-700 dark:hover:bg-zinc-900"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </div>

        {error ? (
          <p
            className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <dl className="mt-8 grid gap-5 rounded-xl bg-zinc-50 p-5 text-sm dark:bg-zinc-900">
          <div>
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">
              Email
            </dt>
            <dd className="mt-1 break-all">
              {account?.email ?? claimsData.claims.email ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">
              Account status
            </dt>
            <dd className="mt-1 capitalize">{account?.status ?? "Unavailable"}</dd>
          </div>
        </dl>

        {!account && !accountError ? (
          <p className="mt-5 text-sm text-amber-700 dark:text-amber-300">
            Your authenticated identity exists, but the application profile is
            not available yet.
          </p>
        ) : null}
      </section>
    </main>
  );
}
