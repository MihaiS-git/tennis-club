import type { ReactNode } from "react";
import Link from "next/link";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { PublicLocation } from "@/lib/courts/public";
import { countLabel, locationAddressLines } from "@/lib/courts/summary";
import { HomeLocationMap, HomeMapLocationLink } from "./home-map-location-link";
import styles from "./page.module.css";

const mapId = "home-location-map";

// A street line plus a city or postal code is required for a trustworthy map
// destination; anything less would let Google Maps guess a place.
export function mapQuery(location: PublicLocation): string | null {
  if (!location.address_line1?.trim() || !(location.city?.trim() || location.postal_code?.trim())) return null;
  return locationAddressLines(location).join(", ");
}

export function directionsUrl(query: string) {
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: query })}`;
}

function todayHoursLabel(location: PublicLocation) {
  return location.todayOpeningHours.length
    ? location.todayOpeningHours.map((h) => `${minuteToTime(h.opens_at_minute)}–${minuteToTime(h.closes_at_minute)}`).join(", ")
    : "Closed today";
}

const linkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`;

export function HomeLocationsShell({ children, map, selectedId }: { children: ReactNode; map: ReactNode; selectedId?: string }) {
  return (
    <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-stretch lg:gap-x-12 xl:gap-x-20">
      <div>
        <h2 id="visit-club-title" className="max-w-[14ch] font-heading text-[clamp(40px,4.4vw,64px)] font-semibold leading-[1.04] tracking-[-0.04em] text-chalk">
          Find your place to play.
        </h2>
        <p className="mt-6 max-w-xl font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">
          Visit the club for courts, coaching and club activity. Choose a location for directions and today’s opening hours.
        </p>
        <div className="mt-12">{children}</div>
      </div>
      <HomeLocationMap id={mapId} selectedId={selectedId} className="-mx-3 mt-12 aspect-[4/3] w-[calc(100%+1.5rem)] md:mx-0 md:mt-16 md:aspect-[3/2] md:w-full lg:-mr-4 lg:ml-0 lg:mt-0 lg:aspect-auto lg:min-h-[480px] lg:w-[calc(100%+1rem)] xl:-mr-12 xl:w-[calc(100%+3rem)]">
        {map}
      </HomeLocationMap>
    </div>
  );
}

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center border border-ivory/30 px-6 text-center font-sans text-base text-ivory">
      {message}
    </div>
  );
}

function LocationEntry({ location, selected, selectable }: { location: PublicLocation; selected: boolean; selectable: boolean }) {
  const addressLines = locationAddressLines(location);
  const query = mapQuery(location);
  return (
    <li aria-current={selectable && selected ? "true" : undefined} className="border-t border-ivory/30 pb-5 pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-heading text-xl font-medium leading-7 text-chalk">{location.name}</h3>
        <span className="font-sans text-sm text-ivory">{countLabel(location.courts.length, "court")}</span>
      </div>
      {addressLines.length > 0 && (
        <address className="mt-2 font-sans text-sm leading-6 text-ivory not-italic">
          {addressLines.map((line, index) => <div key={index}>{line}</div>)}
        </address>
      )}
      <p className="mt-2 font-sans text-sm leading-6 text-ivory">
        <span className="font-semibold text-chalk">Today</span> · <span className="tabular-nums">{todayHoursLabel(location)}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-x-6">
        <Link href={`/book?${new URLSearchParams({ location: location.id })}`} className={linkClassName}>
          <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Book a court</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
        </Link>
        {query && (
          <a href={directionsUrl(query)} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Get directions</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
          </a>
        )}
        {selectable && selected && (
          <span className="inline-flex min-h-11 items-center font-sans text-sm font-semibold text-tennis">Shown on map</span>
        )}
        {selectable && !selected && (
          // Shares the homepage ?location= state with Court availability.
          <HomeMapLocationLink href={`/?${new URLSearchParams({ location: location.id })}`} locationId={location.id} mapId={mapId} className={linkClassName}>
            <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Show on map</span>
          </HomeMapLocationLink>
        )}
      </div>
    </li>
  );
}

export async function HomeLocations({ locations, searchParams }: {
  locations: Promise<PublicLocation[]>; searchParams: Promise<{ location?: string | string[] }>;
}) {
  let publicLocations: PublicLocation[];
  try {
    publicLocations = await locations;
  } catch {
    return (
      <HomeLocationsShell map={<MapPlaceholder message="Map unavailable." />}>
        <p className="border-t border-ivory/30 pt-5 font-sans text-base leading-7 text-ivory">Location information is currently unavailable.</p>
      </HomeLocationsShell>
    );
  }
  if (!publicLocations.length) {
    return (
      <HomeLocationsShell map={<MapPlaceholder message="Map unavailable." />}>
        <div className="border-t border-ivory/30 pt-5 font-sans text-base leading-7">
          <p className="font-semibold text-chalk">No club locations are currently open to the public.</p>
          <p className="mt-1 text-ivory">Please check back soon.</p>
        </div>
      </HomeLocationsShell>
    );
  }

  const { location: requested } = await searchParams;
  const selected = publicLocations.find((item) => item.id === requested) ?? publicLocations[0];
  const query = mapQuery(selected);
  const mapsKey = process.env.GOOGLE_MAPS_EMBED_API_KEY;
  const map = query && mapsKey ? (
    <iframe
      src={`https://www.google.com/maps/embed/v1/place?${new URLSearchParams({ key: mapsKey, q: query })}`}
      title={`Map showing ${selected.name}`}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      allowFullScreen
      className="block h-full w-full border-0"
    />
  ) : (
    <MapPlaceholder message={query ? "Map unavailable." : `A map is not available for ${selected.name}.`} />
  );

  return (
    <HomeLocationsShell map={map} selectedId={selected.id}>
      <ul aria-label="Club locations">
        {publicLocations.map((location) => (
          <LocationEntry key={location.id} location={location} selected={location.id === selected.id} selectable={publicLocations.length > 1} />
        ))}
      </ul>
    </HomeLocationsShell>
  );
}
