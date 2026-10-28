import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { LoadingStatus } from "@/components/loading-status";
import { readPublicCoaching } from "@/lib/coaching/public";
import { listPublicLocationsToday, type PublicLocationToday } from "@/lib/courts/public-calendar";
import styles from "../page.module.css";
import { EditorialHero, editorialHeroHeight as heroHeight, narrowHeroMedia as narrowHero, narrowHeroSizes, portraitHeroMedia as portraitHero } from "../editorial-hero";
import { PageSectionNav, type PageSection } from "../page-section-nav";
import { CoachingRates, CourtRates } from "./pricing-sections";

export const metadata: Metadata = {
  title: "Pricing | Tennis Club",
  description: "Starting prices for court hire and coaching at each club location, what affects them, and how booking and payment work.",
  alternates: { canonical: "/pricing" },
};

const sections: PageSection[] = [
  { id: "courts", label: "Court hire" },
  { id: "coaching", label: "Coaching" },
  { id: "booking", label: "Booking & payment" },
];

// One public locations read per request; coaching is placed on the same locations.
async function readPublicLocations() {
  await connection();
  return listPublicLocationsToday();
}
async function readCoaching(locations: Promise<PublicLocationToday[]>) {
  return readPublicCoaching(await locations);
}

// Reuse the established hero photograph and its existing mobile crops.
const portraitHeroSizes = heroHeight;
const narrowHeroSrcSet = (format: string) =>
  [427, 627].map((width) => `/images/courts/tennis-courts-public-narrow-${width}.${format} ${width}w`).join(", ");
const portraitHeroSrcSet = (format: string) =>
  `/images/courts/tennis-courts-public-portrait-640.${format} 640w, /images/courts/tennis-courts-public-portrait-941.${format} 941w`;
const heroSizes = `max(100vw, calc(${heroHeight} * 16 / 9))`;
const heroSrcSet = (format: string) =>
  [1024, 1280, 1672].map((width) => `/images/courts/tennis-courts-public-${width}.${format} ${width}w`).join(", ");

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const headingClassName = "font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]";
const bodyClassName = "font-sans text-base leading-7 md:text-lg md:leading-8";
const sectionClassName = "scroll-mt-20 px-6 py-14 md:px-8 md:py-20 xl:py-28";
const linkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold transition-colors focus-visible:rounded-control`;

function Factors({ items, dark = false }: { items: string[]; dark?: boolean }) {
  return (
    <ul className={`mt-8 font-sans text-base font-medium ${dark ? "text-chalk" : "text-primary"}`}>
      {items.map((item) => <li key={item} className={`border-t py-3 ${dark ? "border-ivory/30" : "border-border"}`}>{item}</li>)}
    </ul>
  );
}

export default function PricingPage() {
  const locations = readPublicLocations();
  const coaching = readCoaching(locations);

  return (
    <main className="flex-1">
      <EditorialHero
        titleId="pricing-hero-title"
        eyebrow="Pricing"
        title="Court and coaching prices."
        titleClassName="max-w-[13ch]"
        intro="Starting rates for court hire and coaching are indicative, based on the club’s current prices. The exact total appears when you book, before you confirm."
        image={{
          src: "/images/courts/tennis-courts-public-1024.webp",
          srcSet: heroSrcSet("webp"),
          sizes: heroSizes,
          sources: [
            { media: narrowHero, type: "image/avif", srcSet: narrowHeroSrcSet("avif"), sizes: narrowHeroSizes },
            { media: narrowHero, type: "image/webp", srcSet: narrowHeroSrcSet("webp"), sizes: narrowHeroSizes },
            { media: portraitHero, type: "image/avif", srcSet: portraitHeroSrcSet("avif"), sizes: portraitHeroSizes },
            { media: portraitHero, type: "image/webp", srcSet: portraitHeroSrcSet("webp"), sizes: portraitHeroSizes },
            { type: "image/avif", srcSet: heroSrcSet("avif"), sizes: heroSizes },
          ],
          width: 1672,
          height: 941,
          alt: "Clay tennis court at sunset, with rackets and balls beside the court",
          className: "object-[30%_center] md:object-[center_60%]",
        }}
      />
      <PageSectionNav sections={sections} />

      <section id="courts" aria-labelledby="pricing-courts-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Court hire</p>
            <h2 id="pricing-courts-title" className={`${headingClassName} mt-4 max-w-[12ch] text-foreground`}>Hourly rates by location.</h2>
            <p className={`${bodyClassName} mt-5 max-w-xl text-muted-foreground`}>
              Courts are priced per hour, and the rate can change through the day. What you pay depends on:
            </p>
            <Factors items={["The court you choose", "The day and time you play", "The season, and whether a court is open, covered or indoor"]} />
            <p className="mt-6 max-w-xl font-sans text-sm leading-6 text-muted-foreground">
              Each half hour is charged at its own rate, and bookings start at 60 minutes. Today’s lowest rate may apply to only part of the day, so it is not the price of a booking.
            </p>
          </div>
          <div className="min-h-60">
            <Suspense fallback={<LoadingStatus label="Loading court prices…" className="border-t border-border pt-5" />}>
              <CourtRates locations={locations} />
            </Suspense>
          </div>
        </div>
      </section>

      <section id="coaching" aria-labelledby="pricing-coaching-title" className={`${sectionClassName} bg-forest-900 text-chalk`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent-on-dark`}>Coaching</p>
            <h2 id="pricing-coaching-title" className={`${headingClassName} mt-4 max-w-[12ch]`}>Lessons, priced per person.</h2>
            <p className={`${bodyClassName} mt-5 max-w-xl text-ivory`}>
              Every lesson price is what each player pays for one complete lesson. Prices vary by:
            </p>
            <Factors dark items={["Lesson length", "Number of players", "Coach: some coaches set their own Private and Semi-private prices"]} />
            <p className="mt-6 max-w-xl font-sans text-sm leading-6 text-ivory">
              A starting price is the lowest published price for the program, not the price of a particular lesson length, group size or coach. When court rental is not included, the court is charged separately at its rate.
            </p>
            <Link href="/coaching#coaches" prefetch={false} className={`${linkClassName} mt-4 text-chalk hover:text-chalk`}>
              <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Meet the coaches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>
          <div className="min-h-60">
            <Suspense fallback={<LoadingStatus tone="inverse" label="Loading coaching prices…" className="border-t border-ivory/30 pt-5" />}>
              <CoachingRates coaching={coaching} />
            </Suspense>
          </div>
        </div>
      </section>

      <section id="booking" aria-labelledby="pricing-booking-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16 xl:gap-24`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>Booking &amp; payment</p>
              <h2 id="pricing-booking-title" className={`${headingClassName} mt-4 max-w-[12ch] text-foreground`}>How booking and payment work.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              A listed price doesn’t guarantee a free slot. Choose a location, a time and, for lessons, a coach to see what’s available. Your booking summary shows the total to pay.
            </p>
          </div>
          <dl className={`${styles.stagger} mt-10 grid gap-x-10 font-sans text-sm leading-6 md:mt-14 md:grid-cols-3 md:text-base md:leading-7`}>
            <div className="border-t border-border py-5">
              <dt className="font-semibold text-primary">Currency</dt>
              <dd className="mt-1 text-muted-foreground">Each location charges in its own currency. Prices are never converted.</dd>
            </div>
            <div className="border-t border-border py-5">
              <dt className="font-semibold text-primary">Courts</dt>
              <dd className="mt-1 text-muted-foreground">Pay online when you book. Some locations also let you pay at the club.</dd>
            </div>
            <div className="border-t border-border py-5">
              <dt className="font-semibold text-primary">Lessons</dt>
              <dd className="mt-1 text-muted-foreground">Private and Semi-private lessons are paid online. Group and Junior sessions are paid at the club.</dd>
            </div>
          </dl>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
            <Link href="/book" className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover">
              Book a court
            </Link>
            <Link href="/book?mode=coaching" className={`${linkClassName} text-primary hover:text-accent`}>
              <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Book coaching</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
            <Link href="/club#rules" prefetch={false} className={`${linkClassName} text-primary hover:text-accent`}>
              <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Booking and cancellation terms</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
