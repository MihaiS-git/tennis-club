import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background font-sans text-foreground">
      <main className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-accent">
          Tennis Club
        </p>
        <h1 className="mt-4 max-w-xl font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Your club account, ready when you are.
        </h1>
        <p className="mt-5 max-w-lg text-lg leading-8 text-muted-foreground">
          Sign in to access your account or create a member account to get
          started.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            className="rounded-control bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
            href="/login"
          >
            Sign in
          </Link>
          <Link
            className="rounded-control border border-border-strong bg-transparent px-5 py-3 text-sm font-semibold text-primary transition hover:bg-surface-muted"
            href="/signup"
          >
            Create account
          </Link>
        </div>
      </main>
    </div>
  );
}
