import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { listPublicLocationsToday } from "@/lib/courts/public-calendar";
import { EditorialHero, editorialHeroHeight as heroHeight, narrowHeroMedia as narrowHero, narrowHeroSizes, portraitHeroMedia as portraitHero } from "../editorial-hero";
import styles from "../page.module.css";
import { PageSectionNav, type PageSection } from "../page-section-nav";
import { CourtsConditions } from "./courts-conditions";
import { CourtsDiscovery } from "./courts-discovery";
import { LoadingStatus } from "@/components/loading-status";

export const metadata: Metadata = {
  title: "Courts | Tennis Club",
  description: "Explore the club’s courts and locations: surfaces, lighting, today’s opening hours and rates. Members and visitors are welcome to play.",
  alternates: { canonical: "/courts" },
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

// The hero covers a full-width frame clamp(540px, 86svh, 860px) tall. Portrait
// phones get a 2:3 or square slice of the same 30%-positioned crop. Wider
// frames cover with the full 16:9 photograph.
const portraitHeroSizes = heroHeight;
const narrowHeroSrcSet = (format: string) =>
  [427, 627].map((width) => `/images/courts/tennis-courts-public-narrow-${width}.${format} ${width}w`).join(", ");
const portraitHeroSrcSet = (format: string) =>
  `/images/courts/tennis-courts-public-portrait-640.${format} 640w, /images/courts/tennis-courts-public-portrait-941.${format} 941w`;
const heroSizes = `max(100vw, calc(${heroHeight} * 16 / 9))`;
const heroSrcSet = (format: string) =>
  [1024, 1280, 1672].map((width) => `/images/courts/tennis-courts-public-${width}.${format} ${width}w`).join(", ");

// The booking photograph spans the phone width and seven twelfths of the wide grid.
const bookingSizes = "(min-width: 1344px) 709px, (min-width: 1024px) calc((100vw - 128px) * 7 / 12), (min-width: 768px) calc(100vw - 64px), 100vw";
const bookingSrcSet = (format: string) =>
  [480, 768, 1152, 1536].map((width) => `/images/courts/tennis-coaching-session-${width}.${format} ${width}w`).join(", ");

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
              <Link href="/contact" prefetch={false} className={`${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
                <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Plan your visit</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
              </Link>
            </div>
          </div>
          <picture className={`${styles.photo} -mx-6 block aspect-[3/2] overflow-hidden md:mx-0`}>
            <source type="image/avif" srcSet={bookingSrcSet("avif")} sizes={bookingSizes} />
            <img
              src="/images/courts/tennis-coaching-session-768.webp"
              srcSet={bookingSrcSet("webp")}
              sizes={bookingSizes}
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
