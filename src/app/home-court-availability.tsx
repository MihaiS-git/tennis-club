import type { ReactNode } from "react";
import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { localToday } from "@/lib/courts/calendar";
import type { PublicLocation } from "@/lib/courts/public";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { hourlyStartPreview, surfaceLabels } from "@/lib/courts/summary";
import { HomeLocationSelect } from "./home-location-select";
import styles from "./page.module.css";

export function CourtAvailabilityCardShell({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <article aria-labelledby="courts-title" className="rounded-card border border-border bg-surface p-6 md:p-8 lg:p-9">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="mb-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-accent">On court</p>
          <h3 id="courts-title" className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-[30px]">
            Court availability
          </h3>
        </div>
        {aside ?? <span className="hidden font-sans text-sm text-muted-foreground sm:block">Today</span>}
      </div>
      {children}
    </article>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="py-8 font-sans text-sm leading-6">
      <p className="font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  );
}

function BookingLink({ href }: { href: string }) {
  return (
    <Link href={href} className={`${styles.editorialLink} mt-4 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
      <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>View courts</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
    </Link>
  );
}

const unavailable = (
  <CourtAvailabilityCardShell>
    <EmptyState title="Court availability is currently unavailable." detail="Please try again shortly or open the booking page." />
    <BookingLink href="/book" />
  </CourtAvailabilityCardShell>
);

export async function CourtAvailabilityCard({ locations, searchParams }: {
  locations: Promise<PublicLocation[]>; searchParams: Promise<{ location?: string | string[] }>;
}) {
  let publicLocations: PublicLocation[];
  try {
    publicLocations = await locations;
  } catch {
    return unavailable;
  }
  if (!publicLocations.length) {
    return (
      <CourtAvailabilityCardShell>
        <EmptyState title="No club locations are open for booking." detail="Please check back soon." />
      </CourtAvailabilityCardShell>
    );
  }

  const { location: requested } = await searchParams;
  const location = publicLocations.find((item) => item.id === requested) ?? publicLocations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  let preview: ReturnType<typeof hourlyStartPreview>;
  try {
    preview = hourlyStartPreview(await getPublicCourtDay(location, today, today, now));
  } catch {
    return unavailable;
  }

  const aside = publicLocations.length > 1
    ? <HomeLocationSelect key={location.id} locations={publicLocations} selectedId={location.id} />
    : (
      <p className="font-sans text-sm text-muted-foreground sm:text-right">
        <span className="block font-semibold text-primary">{location.name}</span>Today
      </p>
    );
  const bookingHref = `/book?${new URLSearchParams({ location: location.id })}`;

  return (
    <CourtAvailabilityCardShell aside={aside}>
      {!preview.courts.length ? (
        <EmptyState title="No courts are open for booking at this location." detail="Check another location." />
      ) : preview.closed ? (
        <EmptyState title={`${location.name} is closed today.`} detail="Check another date on the booking page." />
      ) : preview.available ? (
        <div>
          {preview.courts.map(({ court, starts }) => (
            <div key={court.id} className="grid gap-3 border-b border-border py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center md:py-6">
              <div className="flex items-baseline gap-3">
                <Link href={bookingHref} className="font-heading text-lg font-semibold text-primary transition-colors hover:text-accent hover:underline hover:decoration-accent focus-visible:rounded-control">{court.name}</Link>
                <span className="font-sans text-sm text-muted-foreground">{surfaceLabels[court.surface]}</span>
              </div>
              {starts.length > 0 ? (
                <ul aria-label={`Available 60-minute start times for ${court.name}`} className="flex flex-wrap gap-2">
                  {starts.map((minute) => (
                    <li key={minute}>
                      <Link href={bookingHref} aria-label={`Book ${court.name} at ${minuteToTime(minute)}`} className="inline-flex min-h-10 min-w-[72px] items-center justify-center rounded-control border border-border-strong bg-background px-3 font-sans text-sm font-semibold tabular-nums text-primary transition-colors hover:border-accent hover:bg-surface-muted hover:text-accent">
                        {minuteToTime(minute)}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="font-sans text-sm text-muted-foreground">No suitable availability today</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No court availability today." detail="Check another date or location." />
      )}
      <BookingLink href={bookingHref} />
    </CourtAvailabilityCardShell>
  );
}
