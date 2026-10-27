import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { listPublicLocationsToday } from "@/lib/courts/public-calendar";
import { EditorialHero } from "../editorial-hero";
import styles from "../page.module.css";
import { PageSectionNav, type PageSection } from "../page-section-nav";
import { CourtsConditions } from "./courts-conditions";
import { CourtsDiscovery } from "./courts-discovery";
import { LoadingStatus } from "@/components/loading-status";

export const metadata: Metadata = {
  title: "Courts | Tennis Club",
  description: "Explore the club’s courts and locations: surfaces, lighting, today’s opening hours and rates. Members and visitors are welcome to play.",
};

// One public locations read per request, shared by court discovery and playing conditions.
async function readPublicLocations() {
  await connection();
  return listPublicLocationsToday();
}

const sections: PageSection[] = [
  { id: "locations", label: "Locations" },
  { id: "conditions", label: "Playing conditions" },
  { id: "book", label: "Booking" },
];

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";

export default function CourtsPage() {
  const locations = readPublicLocations();

  return (
    <main className="flex-1">
      <EditorialHero
        titleId="courts-hero-title"
        eyebrow="Courts"
        title="Courts ready to play."
        titleClassName="max-w-[12ch]"
        intro="Whether you’re a member or visiting for the first time, come enjoy a game at the club."
        image={{
          src: "/images/tennis-courts-public.webp",
          alt: "Clay tennis court at sunset, with rackets and balls beside the court",
          className: "object-[30%_center] md:object-[center_60%]",
        }}
      >
        <a href="#locations" className={`${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
          <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Explore locations</span> <span aria-hidden="true" className="ml-2">↓</span>
        </a>
      </EditorialHero>
      <PageSectionNav sections={sections} />

      <section id="locations" aria-labelledby="courts-overview-title" className="scroll-mt-20 bg-surface px-6 py-14 md:px-8 md:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Locations</p>
            <h2 id="courts-overview-title" className="mt-4 font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
              Find your court.
            </h2>
          </div>
          <div className="mt-6 min-h-96 md:mt-8">
            <Suspense fallback={<LoadingStatus label="Loading court information…" />}>
              <CourtsDiscovery locations={locations} />
            </Suspense>
          </div>
        </div>
      </section>

      {/* Conditions render only for courts that exist; the anchor stays valid either way. */}
      <div id="conditions" className="scroll-mt-20">
        <Suspense fallback={null}>
          <CourtsConditions locations={locations} />
        </Suspense>
      </div>

      <section id="book" aria-labelledby="courts-booking-title" className="scroll-mt-20 bg-forest-900 px-6 py-14 text-chalk md:px-8 md:py-20 lg:py-24">
        <div className={`${styles.stagger} mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-16`}>
          <div>
            <p className={`${eyebrowClassName} text-accent-on-dark`}>Book a court</p>
            <h2 id="courts-booking-title" className="mt-4 max-w-[12ch] font-heading text-[clamp(36px,4.4vw,60px)] font-semibold leading-[1.04] tracking-[-0.04em]">
              Ready to play?
            </h2>
            <p className="mt-5 max-w-md font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">
              Choose a location and a time. The court is yours once your booking is confirmed.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
              <Link href="/book" className="inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted">
                Book a court
              </Link>
              <Link href="/club#visit" className={`${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
                <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Plan your visit</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
              </Link>
            </div>
          </div>
          <picture className={`${styles.photo} -mx-6 block aspect-[3/2] overflow-hidden md:mx-0`}>
            <source type="image/avif" srcSet="/images/tennis-coaching-session.avif" />
            <source type="image/webp" srcSet="/images/tennis-coaching-session.webp" />
            <img
              src="/images/tennis-coaching-session.webp"
              alt="A player strikes a backhand on a clay court while a coach feeds balls from a basket"
              loading="lazy"
              decoding="async"
              width="1536"
              height="1024"
              className="block h-full w-full object-cover"
            />
          </picture>
        </div>
      </section>
    </main>
  );
}
