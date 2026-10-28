import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { LoadingStatus } from "@/components/loading-status";
import { readPublicClubContact } from "@/lib/club/contact";
import { telephoneHref, type ClubContact } from "@/lib/club/schema";
import { listPublicVisitorLocations, type PublicVisitorLocation } from "@/lib/courts/public";
import styles from "../page.module.css";
import { EditorialHero, editorialHeroHeight as heroHeight, narrowHeroMedia as narrowHero, narrowHeroSizes, portraitHeroMedia as portraitHero } from "../editorial-hero";
import { ContactLocations, ContactLocationsShell } from "./contact-locations";
import { jsonLd, locationsStructuredData } from "./structured-data";

export const metadata: Metadata = {
  title: "Contact | Tennis Club",
  description: "Call or email the club, find every location’s address and opening hours, get directions and book a court.",
  alternates: { canonical: "/contact" },
};

type ContactPageProps = { searchParams: Promise<{ location?: string | string[] }> };

async function settle<T>(value: Promise<T>) {
  try {
    return await value;
  } catch {
    return null;
  }
}

// One read each per request: the club-wide contact details and the published locations.
async function readContact() {
  await connection();
  return readPublicClubContact();
}
async function readLocations() {
  await connection();
  return listPublicVisitorLocations();
}

// Reuse the established hero photograph and its existing mobile crops.
const narrowHeroSrcSet = (format: string) =>
  [427, 683].map((width) => `/images/club/tennis-club-aerial-narrow-${width}.${format} ${width}w`).join(", ");
const portraitHeroSrcSet = (format: string) =>
  [640, 896].map((width) => `/images/club/tennis-club-aerial-portrait-${width}.${format} ${width}w`).join(", ");
const heroSizes = `max(100vw, calc(${heroHeight} * 3 / 2))`;
const heroSrcSet = (format: string) =>
  [768, 1152, 1536].map((width) => `/images/home/tennis-club-aerial-${width}.${format} ${width}w`).join(", ");

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const contactLinkClassName = `${styles.editorialLink} inline-flex min-h-11 max-w-full items-center break-all font-heading text-[clamp(24px,2.6vw,34px)] font-semibold leading-tight tracking-[-0.02em] text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`;

async function ClubContactDetails({ contact }: { contact: Promise<ClubContact> }) {
  const details = await settle(contact);
  if (!details) {
    return <p className="max-w-xl border-t border-ivory/30 pt-5 font-sans text-base leading-7 text-ivory">Club contact details are currently unavailable. Each location’s address and opening hours are listed below.</p>;
  }
  const items = [
    ...(details.contactPhone ? [{ label: "Telephone", href: telephoneHref(details.contactPhone), text: details.contactPhone }] : []),
    ...(details.contactEmail ? [{ label: "Email", href: `mailto:${details.contactEmail}`, text: details.contactEmail }] : []),
  ];
  if (!items.length) {
    return (
      <p className="max-w-xl border-t border-ivory/30 pt-5 font-sans text-base leading-7 text-ivory">
        Visit any of our locations during opening hours, or <Link href="/book" className="font-semibold text-chalk underline decoration-accent-on-dark underline-offset-4">book a court online</Link>.
      </p>
    );
  }
  return (
    <dl className="grid max-w-4xl gap-x-12 gap-y-6 border-t border-ivory/30 pt-6 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className={`${eyebrowClassName} text-accent-on-dark`}>{item.label}</dt>
          <dd className="mt-2">
            <a href={item.href} className={contactLinkClassName}>
              <span className={`${styles.editorialLabel} underline decoration-accent-on-dark decoration-2 underline-offset-8`}>{item.text}</span>
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

async function Locations({ locations, searchParams }: { locations: Promise<PublicVisitorLocation[]>; searchParams: ContactPageProps["searchParams"] }) {
  const [publicLocations, { location: requested }] = await Promise.all([settle(locations), searchParams]);
  return <ContactLocations locations={publicLocations} requested={typeof requested === "string" ? requested : undefined} />;
}

async function StructuredData({ locations, contact }: { locations: Promise<PublicVisitorLocation[]>; contact: Promise<ClubContact> }) {
  const [publicLocations, details] = await Promise.all([settle(locations), settle(contact)]);
  if (!publicLocations?.length) return null;
  const data = locationsStructuredData(publicLocations, details ?? { contactEmail: "", contactPhone: "" });
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}

export default function ContactPage({ searchParams }: ContactPageProps) {
  const contact = readContact();
  const locations = readLocations();

  return (
    <main className="flex-1">
      <EditorialHero
        titleId="contact-hero-title"
        eyebrow="Contact"
        title="Talk to the club."
        titleClassName="max-w-[11ch]"
        intro="Questions about courts, coaching or membership? Call or email the club team, or come and see us at any of our locations."
        image={{
          src: "/images/home/tennis-club-aerial-768.webp",
          srcSet: heroSrcSet("webp"),
          sizes: heroSizes,
          sources: [
            { media: narrowHero, type: "image/avif", srcSet: narrowHeroSrcSet("avif"), sizes: narrowHeroSizes },
            { media: narrowHero, type: "image/webp", srcSet: narrowHeroSrcSet("webp"), sizes: narrowHeroSizes },
            { media: portraitHero, type: "image/avif", srcSet: portraitHeroSrcSet("avif"), sizes: heroHeight },
            { media: portraitHero, type: "image/webp", srcSet: portraitHeroSrcSet("webp"), sizes: heroHeight },
            { type: "image/avif", srcSet: heroSrcSet("avif"), sizes: heroSizes },
          ],
          width: 1536,
          height: 1024,
          alt: "The stone clubhouse and its terrace above clay courts, surrounded by olive trees and cypresses in late-afternoon light",
          className: "object-[18%_center] md:object-[center_35%]",
        }}
      />
      <div className="bg-forest-900 px-6 pb-10 text-chalk md:px-8 md:pb-16">
        <div className="mx-auto min-h-56 max-w-7xl sm:min-h-28">
          <Suspense fallback={<LoadingStatus tone="inverse" label="Loading contact details…" className="min-h-24 border-t border-ivory/30 pt-6" />}>
            <ClubContactDetails contact={contact} />
          </Suspense>
        </div>
      </div>

      <section id="locations" aria-labelledby="contact-locations-title" className="scroll-mt-20 bg-background px-6 py-14 md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Locations</p>
            <h2 id="contact-locations-title" className="mt-4 max-w-[14ch] font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
              Find your place to play.
            </h2>
            <p className="mt-5 max-w-2xl font-sans text-base leading-7 text-muted-foreground md:text-lg md:leading-8">
              Opening hours for the coming week, directions and booking for every club location.
            </p>
          </div>
          <Suspense fallback={
            <ContactLocationsShell map={null}>
              <LoadingStatus label="Loading locations…" className="min-h-96 items-start border-t border-border pt-5" />
            </ContactLocationsShell>
          }>
            <Locations locations={locations} searchParams={searchParams} />
          </Suspense>
        </div>
      </section>
      <Suspense fallback={null}>
        <StructuredData locations={locations} contact={contact} />
      </Suspense>
    </main>
  );
}
