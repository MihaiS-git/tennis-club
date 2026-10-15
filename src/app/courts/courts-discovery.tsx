import Link from "next/link";
import { connection } from "next/server";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { listPublicLocationsToday } from "@/lib/courts/public-calendar";
import { locationAddressLines } from "@/lib/courts/summary";
import { formatMoney } from "@/lib/pricing/money";

export async function CourtsDiscovery() {
  await connection();
  const locations = await listPublicLocationsToday();
  const courtCount = locations.reduce((total, location) => total + location.courts.length, 0);

  if (courtCount === 0) {
    return (
      <p className="font-sans text-base leading-7 text-muted-foreground">
        No club locations are currently open for public booking. Please check back soon.
      </p>
    );
  }

  return (
    <div>
      <p className="font-sans text-base leading-7 text-muted-foreground">
        <span className="font-semibold text-primary">{courtCount} {courtCount === 1 ? "court" : "courts"}</span>
        {" across "}{locations.length} {locations.length === 1 ? "location" : "locations"}.
      </p>
      <div className="mt-8 space-y-12 md:mt-10 md:space-y-16">
        {locations.map((location) => {
          const addressLines = locationAddressLines(location);

          return (
            <article key={location.id} aria-labelledby={`location-${location.id}`} className="grid gap-6 border-t border-border pt-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
              <div>
                <h3 id={`location-${location.id}`} className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">
                  {location.name}
                </h3>
                {addressLines.length > 0 && (
                  <address className="mt-4 font-sans text-sm leading-6 text-muted-foreground not-italic md:text-base md:leading-7">
                    {addressLines.map((line, index) => <div key={index}>{line}</div>)}
                  </address>
                )}
                <dl className="mt-4 space-y-1 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">
                  <div>
                    <dt className="sr-only">Courts</dt>
                    <dd>{location.courts.length} {location.courts.length === 1 ? "court" : "courts"}</dd>
                  </div>
                  <div>
                    <dt className="inline">Today: </dt>
                    <dd className="inline font-semibold text-primary">
                      {location.openingHours.length
                        ? location.openingHours.map((h) => `${minuteToTime(h.opens_at_minute)}–${minuteToTime(h.closes_at_minute)}`).join(", ")
                        : "Closed"}
                    </dd>
                  </div>
                  <div>
                    <dt className="sr-only">Hourly rate</dt>
                    <dd>
                      {location.startingRateMinor === null
                        ? "See rates when booking"
                        : `From ${formatMoney(location.startingRateMinor, location.currency)}/hour`}
                    </dd>
                  </div>
                </dl>
                <Link href={`/book?location=${location.id}`} className="mt-6 inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-6 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover">
                  Book at {location.name}
                </Link>
              </div>
              <ul aria-label={`Courts at ${location.name}`}>
                {location.courts.map((court) => (
                  <li key={court.id} className="grid gap-2 border-b border-border py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-baseline sm:gap-6 md:py-5">
                    <h4 className="font-heading text-lg font-semibold text-primary">{court.name}</h4>
                    <dl className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-sm leading-6 text-muted-foreground">
                      <div>
                        <dt className="sr-only">Surface</dt>
                        <dd>{court.surface.charAt(0).toUpperCase() + court.surface.slice(1)}</dd>
                      </div>
                      <div>
                        <dt className="sr-only">Environment</dt>
                        <dd>{court.environment === "indoor" ? "Indoor" : "Outdoor"}</dd>
                      </div>
                      {court.has_lighting && (
                        <div>
                          <dt className="sr-only">Lighting</dt>
                          <dd>Floodlit</dd>
                        </div>
                      )}
                    </dl>
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
