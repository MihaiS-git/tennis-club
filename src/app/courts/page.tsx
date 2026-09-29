import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { temporaryCourtInformation } from "@/lib/courts/config";

import { CourtsDiscovery } from "./courts-discovery";

export const metadata: Metadata = {
  title: "Courts | Tennis Club",
  description: "Explore the club’s courts and locations. Members and visitors are welcome to play, with rackets and balls available.",
};

export default function CourtsPage() {
  return (
    <main className="flex-1">
      <section aria-labelledby="courts-hero-title" className="px-6 py-10 md:px-8 md:py-16 lg:py-20">
        <div className="mx-auto grid max-w-7xl items-center gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10 lg:gap-16">
          <div>
            <p className="mb-4 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-accent">Courts</p>
            <h1 id="courts-hero-title" className="max-w-[12ch] font-heading text-[clamp(42px,5vw,72px)] font-semibold leading-[1.04] tracking-[-0.045em] text-foreground">
              Clay courts, ready to play.
            </h1>
            <p className="mt-6 max-w-md font-sans text-base leading-7 text-muted-foreground md:text-lg md:leading-8">
              Whether you’re a member or visiting for the first time, come enjoy a game at the club.
            </p>
            <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 font-sans text-sm font-semibold text-primary">
              <li>{temporaryCourtInformation.openingHours}</li>
              <li>{temporaryCourtInformation.basePrice}</li>
            </ul>
          </div>
          <picture className="block overflow-hidden">
            <source type="image/avif" srcSet="/images/tennis-courts-public.avif" />
            <source type="image/webp" srcSet="/images/tennis-courts-public.webp" />
            <img
              src="/images/tennis-courts-public.webp"
              alt="Clay tennis court at sunset, with rackets and balls beside the court"
              width="1672"
              height="941"
              fetchPriority="high"
              decoding="async"
              className="block aspect-[4/3] w-full object-cover md:aspect-square lg:aspect-[4/3]"
            />
          </picture>
        </div>
      </section>

      <section aria-labelledby="courts-overview-title" className="bg-surface px-6 py-16 md:px-8 md:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <h2 id="courts-overview-title" className="font-heading text-[clamp(32px,4vw,52px)] font-semibold leading-tight tracking-[-0.035em] text-foreground">
            Find your court.
          </h2>
          <div className="mt-8 min-h-96 md:mt-10">
            <Suspense fallback={<p role="status" className="font-sans text-base leading-7 text-muted-foreground">Loading court information…</p>}>
              <CourtsDiscovery />
            </Suspense>
          </div>
        </div>
      </section>

      <section aria-labelledby="courts-equipment-title" className="px-6 py-16 md:px-8 md:py-20">
        <div className="mx-auto grid max-w-7xl gap-4 border-t border-border pt-6 md:grid-cols-2 md:gap-12">
          <h2 id="courts-equipment-title" className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">
            Rackets and balls available
          </h2>
          <p className="max-w-xl font-sans text-base leading-7 text-muted-foreground md:text-lg">
            The club provides rackets and balls for players. Come ready for a game.
          </p>
        </div>
      </section>

      <section aria-labelledby="courts-booking-title" className="bg-forest-900 px-6 py-16 md:px-8 md:py-20 lg:py-24">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <h2 id="courts-booking-title" className="font-heading text-[clamp(36px,4vw,56px)] font-semibold leading-tight tracking-[-0.035em] text-chalk">
            Ready to play?
          </h2>
          <Link href="/book" className="inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted md:w-auto">
            Book a court
          </Link>
        </div>
      </section>
    </main>
  );
}
