import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { PublicLocation } from "@/lib/courts/public";
import styles from "./page.module.css";

function todayHoursLabel(location: PublicLocation) {
  return location.todayOpeningHours.length
    ? location.todayOpeningHours.map((h) => `${minuteToTime(h.opens_at_minute)}–${minuteToTime(h.closes_at_minute)}`).join(", ")
    : "Closed today";
}

// Each public location links to its address, hours and map on the Contact page.
// Without locations the section's own calls to action still lead there.
export async function HomeLocations({ locations }: { locations: Promise<PublicLocation[]> }) {
  let publicLocations: PublicLocation[];
  try {
    publicLocations = await locations;
  } catch {
    return null;
  }
  if (!publicLocations.length) return null;

  return (
    <ul aria-label="Club locations" className="border-b border-ivory/30">
      {publicLocations.map((location) => (
        <li key={location.id} className="border-t border-ivory/30">
          <Link href={`/contact?${new URLSearchParams({ location: location.id })}`} prefetch={false}
            className={`${styles.editorialLink} flex min-h-20 items-center justify-between gap-6 py-4 text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
            <span className="min-w-0">
              <span className={`${styles.editorialLabel} block font-heading text-xl font-medium leading-7 underline decoration-transparent underline-offset-8 md:text-2xl`}>{location.name}</span>
              <span className="mt-1 block font-sans text-sm leading-6 text-ivory">
                {location.city && <>{location.city} · </>}<span className="font-semibold text-chalk">Today</span> <span className="tabular-nums">{todayHoursLabel(location)}</span>
              </span>
            </span>
            <span aria-hidden="true" className={`${styles.editorialArrow} shrink-0 font-sans text-lg`}>→</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
