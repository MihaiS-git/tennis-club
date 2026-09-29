import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center bg-background px-6 py-24 md:px-8 md:py-32">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-heading text-6xl font-semibold tracking-tight text-accent md:text-7xl">
          404
        </h1>
        <h2 className="mt-6 font-heading text-4xl font-semibold leading-tight tracking-tight text-primary md:text-5xl">
          This page is out of bounds.
        </h2>
        <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground md:text-lg">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            Back to home
          </Link>
          <Link
            href="/book"
            className="inline-flex min-h-12 items-center justify-center rounded-control border border-border-strong bg-surface px-6 text-sm font-semibold text-primary hover:bg-surface-muted hover:text-accent"
          >
            Book a court
          </Link>
        </div>
      </div>
    </main>
  );
}
