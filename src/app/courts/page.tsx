import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { listPublicLocationsToday } from "@/lib/courts/public-calendar";
import styles from "../page.module.css";
import { CourtsConditions } from "./courts-conditions";
import { CourtsDiscovery } from "./courts-discovery";

export const metadata: Metadata = {
  title: "Courts | Tennis Club",
  description: "Explore the club’s courts and locations: surfaces, lighting, today’s opening hours and rates. Members and visitors are welcome to play.",
};

// One public locations read per request, shared by court discovery and playing conditions.
async function readPublicLocations() {
  await connection();
  return listPublicLocationsToday();
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";

export default function CourtsPage() {
  const locations = readPublicLocations();

  return (
    <main className="flex-1">
      <section aria-labelledby="courts-hero-title" className="bg-background md:grid md:grid-cols-[minmax(0,1fr)_min(44%,35rem)_min(56%,45rem)_minmax(0,1fr)]">
        <div className={`${styles.heroEntrance} px-6 pb-8 pt-10 md:col-start-2 md:self-center md:px-8 md:py-16 lg:py-24 lg:pr-14`}>
          <p className={`${eyebrowClassName} flex items-center gap-3 text-accent`}>
            <span aria-hidden="true" className="h-0.5 w-8 bg-accent" />Courts
          </p>
          <h1 id="courts-hero-title" className="mt-4 max-w-[12ch] font-heading text-[clamp(42px,5vw,72px)] font-semibold leading-[1.02] tracking-[-0.045em] text-foreground">
            Courts ready to play.
          </h1>
          <p className="mt-5 max-w-[34ch] text-pretty font-sans text-base leading-7 text-muted-foreground md:mt-6 md:text-lg md:leading-8">
            Whether you’re a member or visiting for the first time, come enjoy a game at the club.
          </p>
          <a href="#courts-overview-title" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
            <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Explore locations</span> <span aria-hidden="true" className="ml-2">↓</span>
          </a>
        </div>
        <picture className="block aspect-[4/3] overflow-hidden md:col-span-2 md:col-start-3 md:aspect-auto md:min-h-[480px] lg:min-h-[clamp(540px,70svh,700px)]">
          <source type="image/avif" srcSet="/images/tennis-courts-public.avif" />
          <source type="image/webp" srcSet="/images/tennis-courts-public.webp" />
          <img
            src="/images/tennis-courts-public.webp"
            alt="Clay tennis court at sunset, with rackets and balls beside the court"
            width="1672"
            height="941"
            fetchPriority="high"
            decoding="async"
            className={`${styles.heroImage} block h-full w-full object-cover object-[30%_center] md:object-[24%_center]`}
          />
        </picture>
      </section>

      <section aria-labelledby="courts-overview-title" className="bg-surface px-6 py-14 md:px-8 md:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Locations</p>
            <h2 id="courts-overview-title" className="mt-4 scroll-mt-24 font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
              Find your court.
            </h2>
          </div>
          <div className="mt-6 min-h-96 md:mt-8">
            <Suspense fallback={<p role="status" className="font-sans text-base leading-7 text-muted-foreground">Loading court information…</p>}>
              <CourtsDiscovery locations={locations} />
            </Suspense>
          </div>
        </div>
      </section>

      <Suspense fallback={null}>
        <CourtsConditions locations={locations} />
      </Suspense>

      <section aria-labelledby="courts-booking-title" className="bg-forest-900 px-6 py-14 text-chalk md:px-8 md:py-20 lg:py-24">
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
