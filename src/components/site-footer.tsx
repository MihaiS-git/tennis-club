import { ProfileDepartureLink as Link } from "./profile-departure-navigation";

export function SiteFooter() {
  return (
    <footer className="border-t border-ivory/20 bg-forest-800 text-chalk">
      <div className="mx-auto max-w-7xl px-6 pb-8 pt-14 md:px-8 md:pt-16 lg:px-6 xl:px-8">
        <div className="grid gap-10 md:grid-cols-2 md:gap-12">
          <div>
            <p className="font-heading text-xl font-semibold tracking-tight">
              Tennis Club
            </p>
            <Link
              href="/#locations"
              className="mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-ivory hover:text-clay-300"
            >
              Our locations
            </Link>
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
