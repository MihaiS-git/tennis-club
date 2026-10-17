import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { PublicCourt } from "@/lib/courts/public";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";
import { locationAddressLines, surfaceLabels } from "@/lib/courts/summary";
import { formatMoney } from "@/lib/pricing/money";

const labelClassName = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-sans text-xs font-medium leading-5";

// Surface is the defining attribute, so it alone carries a tint.
const surfaceTint: Record<PublicCourt["surface"], string> = {
  clay: "bg-clay-100 text-clay-700",
  hard: "bg-forest-100 text-forest-800",
  grass: "bg-forest-100 text-forest-800",
  carpet: "bg-surface-muted text-foreground",
};

function CourtAttributes({ court }: { court: PublicCourt }) {
  return (
    <dl className="flex flex-wrap gap-1.5">
      <div>
        <dt className="sr-only">Surface</dt>
        <dd className={`${labelClassName} ${surfaceTint[court.surface]}`}>{surfaceLabels[court.surface]}</dd>
      </div>
      <div>
        <dt className="sr-only">Environment</dt>
        <dd className={`${labelClassName} border border-border text-foreground`}>{court.environment === "indoor" ? "Indoor" : "Outdoor"}</dd>
      </div>
      <div>
        <dt className="sr-only">Lighting</dt>
        {court.has_lighting ? (
          <dd className={`${labelClassName} border border-border text-foreground`}><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />Floodlit</dd>
        ) : (
          <dd className={`${labelClassName} text-muted-foreground`}>No lighting</dd>
        )}
      </div>
    </dl>
  );
}

export async function CourtsDiscovery({ locations }: { locations: Promise<PublicLocationToday[]> }) {
  const publicLocations = await locations;
  const courtCount = publicLocations.reduce((total, location) => total + location.courts.length, 0);

  if (courtCount === 0) {
    return (
      <p className="border-t border-border pt-5 font-sans text-base leading-7 text-muted-foreground">
        No club locations are currently open for public booking. Please check back soon.
      </p>
    );
  }

  const numbered = publicLocations.length > 1;
  return (
    <div>
      <p className="font-sans text-base leading-7 text-muted-foreground">
        <span className="font-semibold text-primary">{courtCount} {courtCount === 1 ? "court" : "courts"}</span>
        {" across "}{publicLocations.length} {publicLocations.length === 1 ? "location" : "locations"}.
      </p>
      <div className="mt-8 space-y-14 md:mt-10 md:space-y-20">
        {publicLocations.map((location, index) => {
          const addressLines = locationAddressLines(location);

          return (
            <article key={location.id} aria-labelledby={`location-${location.id}`} className="grid gap-8 border-t-2 border-primary pt-6 md:pt-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
              <div className="lg:sticky lg:top-24 lg:self-start">
                {numbered && (
                  <p aria-hidden="true" className="font-sans text-xs font-semibold tabular-nums tracking-[0.16em] text-accent">{String(index + 1).padStart(2, "0")}</p>
                )}
                <h3 id={`location-${location.id}`} className="mt-2 font-heading text-[clamp(30px,3.6vw,46px)] font-semibold leading-[1.05] tracking-[-0.035em] text-primary">
                  {location.name}
                </h3>
                {addressLines.length > 0 && (
                  <address className="mt-3 font-sans text-sm leading-6 text-muted-foreground not-italic md:text-base md:leading-7">
                    {addressLines.join(" · ")}
                  </address>
                )}
                <dl className="mt-6 grid grid-cols-3 border-y border-border font-sans">
                  <div className="py-4 pr-3">
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Courts</dt>
                    <dd className="mt-1 font-heading text-2xl font-semibold tabular-nums text-primary">{location.courts.length}</dd>
                  </div>
                  <div className="border-l border-border py-4 pl-3 pr-3 md:pl-4">
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Today</dt>
                    <dd className="mt-1 text-sm font-semibold leading-6 tabular-nums text-primary md:text-base">
                      {location.openingHours.length
                        ? location.openingHours.map((h) => `${minuteToTime(h.opens_at_minute)}–${minuteToTime(h.closes_at_minute)}`).join(", ")
                        : "Closed"}
                    </dd>
                  </div>
                  <div className="border-l border-border py-4 pl-3 md:pl-4">
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Hourly rate</dt>
                    <dd className="mt-1 text-sm font-semibold leading-6 text-primary md:text-base">
                      {location.startingRateMinor === null
                        ? "See rates when booking"
                        : `From ${formatMoney(location.startingRateMinor, location.currency)}/hour`}
                    </dd>
                  </div>
                </dl>
                <Link href={`/book?location=${location.id}`} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-control bg-primary px-6 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover sm:w-auto">
                  Book at {location.name}
                </Link>
              </div>
              <ul aria-label={`Courts at ${location.name}`} className="self-start">
                {location.courts.map((court) => (
                  <li key={court.id} className="grid gap-2 border-b border-border py-3.5 first:border-t sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-center sm:gap-6 md:py-4">
                    <h4 className="font-heading text-lg font-semibold text-primary">{court.name}</h4>
                    <CourtAttributes court={court} />
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </div>
  );
}
