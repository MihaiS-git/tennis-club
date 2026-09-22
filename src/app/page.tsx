import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          Tennis Club
        </p>
        <h1 className="mt-4 max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Your club account, ready when you are.
        </h1>
        <p className="mt-5 max-w-lg text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Sign in to access your account or create a member account to get
          started.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            className="rounded-lg bg-emerald-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800"
            href="/login"
          >
            Sign in
          </Link>
          <Link
            className="rounded-lg border border-zinc-300 px-5 py-3 text-sm font-semibold transition hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
            href="/signup"
          >
            Create account
          </Link>
        </div>
      </main>
    </div>
  );
}
