import type { ReactNode } from "react";
import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { PublicVisitorLocation } from "@/lib/courts/public";
import { countLabel, locationAddressLines } from "@/lib/courts/summary";
import { directionsUrl, mapEmbedUrl, mapQuery } from "@/lib/locations/directions";
import styles from "../page.module.css";
import { LocationMap, MapFrame, MapLocationLink } from "./location-map";

const mapId = "location-map";
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

const linkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`;
const labelClassName = `${styles.editorialLabel} underline decoration-accent underline-offset-8`;

export function ContactLocationsShell({ children, map, selectedId }: { children: ReactNode; map: ReactNode; selectedId?: string }) {
  return (
    <div className="mt-10 lg:mt-14 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-x-12 xl:gap-x-20">
      <div>{children}</div>
      <LocationMap id={mapId} selectedId={selectedId} className="-mx-6 mt-10 aspect-[4/3] scroll-mt-20 overflow-hidden bg-forest-900 md:mx-0 md:aspect-[3/2] lg:sticky lg:top-24 lg:mt-0 lg:aspect-[4/5] xl:aspect-square">
        {map}
      </LocationMap>
    </div>
  );
}

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center px-6 text-center font-sans text-base text-ivory">
      {message}
    </div>
  );
}

function LocationEntry({ location, index, selected, selectable }: {
  location: PublicVisitorLocation; index: number; selected: boolean; selectable: boolean;
}) {
  const addressLines = locationAddressLines(location);
  const query = mapQuery(location);
  return (
    <li aria-current={selectable && selected ? "true" : undefined} className="border-t border-border py-8 first:pt-6 md:py-10 md:first:pt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-heading text-[clamp(26px,3vw,36px)] font-semibold leading-tight tracking-[-0.03em] text-foreground">
          {selectable && <span aria-hidden="true" className="mr-3 align-middle font-sans text-xs font-semibold tabular-nums tracking-[0.16em] text-accent">{String(index + 1).padStart(2, "0")}</span>}
          {location.name}
        </h3>
        <span className="font-sans text-sm text-muted-foreground">{countLabel(location.courts.length, "court")}</span>
      </div>
      {addressLines.length > 0 && (
        <address className="mt-3 font-sans text-base leading-7 text-muted-foreground not-italic">
          {addressLines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}
        </address>
      )}
      <div className="mt-3 flex flex-wrap gap-x-6">
        {query && (
          <a href={directionsUrl(query)} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            <span className={labelClassName}>Get directions</span>
            <span className="sr-only"> to {location.name} (opens in a new tab)</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>↗</span>
          </a>
        )}
        <Link href={`/book?${new URLSearchParams({ location: location.id })}`} className={linkClassName}>
          <span className={labelClassName}>Book at {location.name}</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
        </Link>
        {selectable && selected && (
          <span className="inline-flex min-h-11 items-center font-sans text-sm font-semibold text-accent">Shown on map</span>
        )}
        {selectable && !selected && (
          <MapLocationLink href={`/contact?${new URLSearchParams({ location: location.id })}`} locationId={location.id} mapId={mapId} className={linkClassName}>
            <span className={labelClassName}>Show on map</span><span className="sr-only">: {location.name}</span>
          </MapLocationLink>
        )}
      </div>
      <h4 className="mt-6 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Opening hours for the coming week</h4>
      <dl className="mt-2 font-sans text-sm leading-6 md:text-base md:leading-7">
        {groupOpeningHours(location.weekOpeningHours).map((row) => (
          <div key={row.days} className="flex justify-between gap-6 border-b border-border py-2">
            <dt className="text-muted-foreground">{row.days}</dt>
            <dd className={`tabular-nums ${row.hours === "Closed" ? "text-muted-foreground" : "font-medium text-foreground"}`}>{row.hours}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export function ContactLocations({ locations, requested }: { locations: PublicVisitorLocation[] | null; requested?: string }) {
  if (!locations) {
    return (
      <ContactLocationsShell map={<MapPlaceholder message="Map unavailable." />}>
        <p className="border-t border-border pt-5 font-sans text-base leading-7 text-muted-foreground">Location information is currently unavailable.</p>
      </ContactLocationsShell>
    );
  }
  if (!locations.length) {
    return (
      <ContactLocationsShell map={<MapPlaceholder message="Map unavailable." />}>
        <div className="border-t border-border pt-5 font-sans text-base leading-7">
          <p className="font-semibold text-foreground">No club locations are currently open to the public.</p>
          <p className="mt-1 text-muted-foreground">Please check back soon.</p>
        </div>
      </ContactLocationsShell>
    );
  }

  const selected = locations.find((item) => item.id === requested) ?? locations[0];
  const query = mapQuery(selected);
  const src = query && mapEmbedUrl(query);
  const map = query && src
    ? <MapFrame src={src} locationName={selected.name} address={query} />
    : <MapPlaceholder message={query ? "Map unavailable." : `A map is not available for ${selected.name}.`} />;

  return (
    <ContactLocationsShell map={map} selectedId={selected.id}>
      <ul aria-label="Club locations">
        {locations.map((location, index) => (
          <LocationEntry key={location.id} location={location} index={index} selected={location.id === selected.id} selectable={locations.length > 1} />
        ))}
      </ul>
    </ContactLocationsShell>
  );
}
