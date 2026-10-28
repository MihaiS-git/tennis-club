"use client";

import { useEffect, useSyncExternalStore, type ComponentProps } from "react";
import Link from "next/link";

// Location whose map a "Show on map" click asked to reveal once rendered. Only
// set by that link, so initial loads and history navigation never scroll.
let requestedLocationId: string | null = null;

// Google Maps loads only after the visitor asks for a map; the choice lasts for
// the rest of the visit so later location changes update the loaded map.
let mapRequested = false;
const listeners = new Set<() => void>();
function requestMap() {
  if (mapRequested) return;
  mapRequested = true;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function revealMap(map: HTMLElement) {
  const header = [...document.querySelectorAll<HTMLElement>("header")]
    .find((element) => getComputedStyle(element).position === "sticky" && element.offsetHeight > 0);
  const headerHeight = header?.offsetHeight ?? 0;
  const { top, height } = map.getBoundingClientRect();
  // Center within the viewport below the header; a taller map aligns under it.
  const inset = Math.max(0, (document.documentElement.clientHeight - headerHeight - height) / 2);
  window.scrollTo({
    top: top + window.scrollY - headerHeight - inset,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

// Selects a location through the ?location= URL state and loads its map. Below the
// desktop two-column layout the map sits under the list, so it is brought into view.
export function MapLocationLink({ locationId, mapId, ...props }: Omit<ComponentProps<typeof Link>, "scroll" | "onClick"> & {
  locationId: string; mapId: string;
}) {
  return <Link {...props} scroll={false} onClick={() => {
    requestMap();
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const map = document.getElementById(mapId);
    // Already rendered for this location: no navigation update to wait for.
    if (map?.dataset.locationId === locationId) revealMap(map);
    else requestedLocationId = locationId;
  }} />;
}

// Map container; scrolls itself into view after the requested selection commits.
export function LocationMap({ selectedId, ...props }: ComponentProps<"div"> & { id: string; selectedId?: string }) {
  useEffect(() => {
    const requested = requestedLocationId;
    requestedLocationId = null;
    const map = document.getElementById(props.id);
    if (map && requested && requested === selectedId) revealMap(map);
  }, [selectedId, props.id]);
  return <div {...props} data-location-id={selectedId} />;
}

// The embedded map of one location, shown as a placeholder until the visitor asks for it.
export function MapFrame({ src, locationName, address }: { src: string; locationName: string; address: string }) {
  const requested = useSyncExternalStore(subscribe, () => mapRequested, () => false);
  if (requested) {
    return <iframe src={src} title={`Map showing ${locationName}`} referrerPolicy="no-referrer-when-downgrade" allowFullScreen
      className="block h-full w-full border-0" />;
  }
  return (
    <div className="flex h-full w-full flex-col items-start justify-end gap-5 bg-forest-900 p-6 text-chalk md:p-10">
      <div>
        <p className="font-heading text-2xl font-semibold leading-tight tracking-[-0.02em] md:text-3xl">{locationName}</p>
        <p className="mt-2 max-w-[40ch] font-sans text-sm leading-6 text-ivory md:text-base md:leading-7">{address}</p>
      </div>
      <button type="button" onClick={requestMap}
        className="inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted">
        Show map<span className="sr-only"> of {locationName}</span>
      </button>
      <p className="max-w-[48ch] font-sans text-xs leading-5 text-ivory">The map is provided by Google Maps and loads only when you choose to show it.</p>
    </div>
  );
}
