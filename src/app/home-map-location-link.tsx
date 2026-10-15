"use client";

import { useEffect, type ComponentProps } from "react";
import Link from "next/link";

// Location whose map a "Show on map" click asked to reveal once rendered. Only
// set by that link, so initial loads, history navigation and the availability
// selector never scroll.
let requestedLocationId: string | null = null;

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

// Selects a location through the shared ?location= URL state. Below the desktop
// two-column layout the map sits under the list, so it is brought into view.
export function HomeMapLocationLink({ locationId, mapId, ...props }: Omit<ComponentProps<typeof Link>, "scroll" | "onClick"> & {
  locationId: string; mapId: string;
}) {
  return <Link {...props} scroll={false} onClick={() => {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const map = document.getElementById(mapId);
    // Already rendered for this location: no navigation update to wait for.
    if (map?.dataset.locationId === locationId) revealMap(map);
    else requestedLocationId = locationId;
  }} />;
}

// Map container; scrolls itself into view after the requested selection commits.
export function HomeLocationMap({ selectedId, ...props }: ComponentProps<"div"> & { id: string; selectedId?: string }) {
  useEffect(() => {
    const requested = requestedLocationId;
    requestedLocationId = null;
    const map = document.getElementById(props.id);
    if (map && requested && requested === selectedId) revealMap(map);
  }, [selectedId, props.id]);
  return <div {...props} data-location-id={selectedId} />;
}
