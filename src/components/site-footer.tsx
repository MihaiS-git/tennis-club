import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-ivory/20 bg-forest-800 text-chalk">
      <div className="mx-auto max-w-7xl px-6 pb-8 pt-14 md:px-8 md:pt-16 lg:px-6 xl:px-8">
        <div className="grid gap-10 md:grid-cols-2 md:gap-12">
          <div>
            <p className="font-heading text-xl font-semibold tracking-tight">
              Tennis Club
            </p>
            <address className="mt-4 font-sans text-sm leading-6 text-ivory not-italic">
              Parcul Central Simion Bărnuțiu
              <br />
              Cluj-Napoca
            </address>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3"
          >
            <Link
              href="/book"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Book a court
            </Link>
            <Link
              href="/matches"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Matches
            </Link>
            <Link
              href="/coaching"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Coaching
            </Link>
            <Link
              href="/courts"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Courts
            </Link>
            <Link
              href="/rankings"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Rankings
            </Link>
            <Link
              href="/club"
              className="inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Club
            </Link>
          </nav>
        </div>

        <div className="mt-12 border-t border-ivory/20 pt-6 font-sans text-sm text-ivory">
          Tennis Club · © 2026{" "}
          <a
            href="https://brutecx.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-chalk hover:text-accent"
          >
            BruteCX
          </a>
        </div>
      </div>
    </footer>
  );
}
