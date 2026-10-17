import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";
import type { PublicVisitorLocation } from "@/lib/courts/public";
import { locationAddressLines } from "@/lib/courts/summary";
import { directionsUrl, mapQuery } from "../home-locations";
import styles from "../page.module.css";

const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Week = PublicVisitorLocation["weekOpeningHours"];

// Consecutive weekdays sharing the same intervals collapse into one row.
export function groupOpeningHours(week: Week) {
  const groups: { first: number; last: number; hours: string }[] = [];
  for (const day of week) {
    const hours = day.intervals.length
      ? day.intervals.map((h) => `${minuteToTime(h.opens_at_minute)}–${minuteToTime(h.closes_at_minute)}`).join(", ")
      : "Closed";
    const previous = groups.at(-1);
    if (previous && previous.hours === hours && previous.last === day.weekday - 1) previous.last = day.weekday;
    else groups.push({ first: day.weekday, last: day.weekday, hours });
  }
  return groups.map(({ first, last, hours }) => ({
    days: first === last ? weekdayNames[first] : `${weekdayNames[first]} – ${weekdayNames[last]}`, hours,
  }));
}

function cancellationTerm(minutes: number | null) {
  if (minutes === null) return null;
  return minutes === 0 ? "Cancel any time before the booking starts" : `Cancel with at least ${customerCancellationNoticeLabel(minutes)}`;
}

const linkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`;

async function settle(locations: Promise<PublicVisitorLocation[]>) {
  try {
    return await locations;
  } catch {
    return null;
  }
}

export async function ClubLocations({ locations }: { locations: Promise<PublicVisitorLocation[]> }) {
  const publicLocations = await settle(locations);
  if (!publicLocations) {
    return <p className="border-t border-ivory/30 pt-5 font-sans text-base leading-7 text-ivory">Location information is currently unavailable.</p>;
  }
  if (!publicLocations.length) {
    return (
      <div className="border-t border-ivory/30 pt-5 font-sans text-base leading-7">
        <p className="font-semibold text-chalk">No club locations are currently open to the public.</p>
        <p className="mt-1 text-ivory">Please check back soon.</p>
      </div>
    );
  }

  return (
    <ul aria-label="Club locations" className={styles.stagger}>
      {publicLocations.map((location, index) => {
        const addressLines = locationAddressLines(location);
        const query = mapQuery(location);
        return (
          <li key={location.id} className="grid gap-6 border-t border-ivory/30 py-8 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:gap-10 md:py-10 lg:gap-16">
            <div>
              {publicLocations.length > 1 && (
                <p aria-hidden="true" className="font-sans text-xs font-semibold tabular-nums tracking-[0.16em] text-accent-on-dark">{String(index + 1).padStart(2, "0")}</p>
              )}
              <h3 className="mt-2 font-heading text-[clamp(26px,3vw,36px)] font-semibold leading-tight tracking-[-0.03em] text-chalk">{location.name}</h3>
              {addressLines.length > 0 && (
                <address className="mt-3 font-sans text-base leading-7 text-ivory not-italic">
                  {addressLines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}
                </address>
              )}
              <div className="mt-4 flex flex-wrap gap-x-6">
                {query && (
                  <a href={directionsUrl(query)} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                    <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Get directions</span>
                    <span className="sr-only"> to {location.name} (opens in a new tab)</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>↗</span>
                  </a>
                )}
                <Link href={`/book?${new URLSearchParams({ location: location.id })}`} className={linkClassName}>
                  <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Book at {location.name}</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                </Link>
              </div>
            </div>
            <div>
              <h4 className="font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ivory">Opening hours for the coming week</h4>
              <dl className="mt-3 font-sans text-sm leading-6 md:text-base md:leading-7">
                {groupOpeningHours(location.weekOpeningHours).map((row) => (
                  <div key={row.days} className="flex justify-between gap-6 border-b border-ivory/15 py-2">
                    <dt className="text-ivory">{row.days}</dt>
                    <dd className={`tabular-nums ${row.hours === "Closed" ? "text-ivory" : "font-medium text-chalk"}`}>{row.hours}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Booking terms each public location currently applies, as configured.
export async function ClubBookingTerms({ locations }: { locations: Promise<PublicVisitorLocation[]> }) {
  const publicLocations = await settle(locations);
  if (!publicLocations) {
    return <p className="border-t border-border pt-4 font-sans text-sm leading-6 text-muted-foreground">Location booking terms are currently unavailable.</p>;
  }
  if (!publicLocations.length) return null;

  return (
    <ul aria-label="Booking terms by location" className="font-sans text-sm leading-6 md:text-base md:leading-7">
      {publicLocations.map((location) => {
        const terms = [cancellationTerm(location.cancellationNoticeMinutes), location.allow_pay_at_club ? "Pay at the club available" : null]
          .filter((term): term is string => Boolean(term));
        return (
          <li key={location.id} className="border-t border-border py-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-6">
            <p className="font-semibold text-primary">{location.name}</p>
            {terms.length > 0 && (
              <ul className="text-muted-foreground">
                {terms.map((term) => <li key={term}>{term}</li>)}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
