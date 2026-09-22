import Link from "next/link";
import { redirect } from "next/navigation";

import { signUp } from "@/lib/auth/actions";
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
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          Tennis Club
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Create an account
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Every new account starts with member access.
        </p>

        {error ? (
          <p
            className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <form action={signUp} className="mt-6 space-y-5">
          <div>
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <input
              autoComplete="email"
              className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-zinc-700 dark:bg-zinc-900"
              id="email"
              name="email"
              required
              type="email"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="password">
              Password
            </label>
            <input
              autoComplete="new-password"
              className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-zinc-700 dark:bg-zinc-900"
              id="password"
              maxLength={72}
              minLength={8}
              name="password"
              required
              type="password"
            />
            <p className="mt-1.5 text-xs text-zinc-500">
              Use 8 to 72 characters.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="confirmPassword">
              Confirm password
            </label>
            <input
              autoComplete="new-password"
              className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 dark:border-zinc-700 dark:bg-zinc-900"
              id="confirmPassword"
              maxLength={72}
              minLength={8}
              name="confirmPassword"
              required
              type="password"
            />
          </div>
          <button
            className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            type="submit"
          >
            Create account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Already registered?{" "}
          <Link
            className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
            href="/login"
          >
            Sign in
          </Link>
        </p>
      </section>
    </main>
  );
}
