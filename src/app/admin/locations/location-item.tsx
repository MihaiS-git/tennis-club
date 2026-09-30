"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminLocation } from "@/lib/admin/locations";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { countryFlag } from "@/lib/profile/countries";
import { LocationDialog } from "./location-dialog";

function Status({ location }: { location: AdminLocation }) {
  if (location.archived_at) return <span className="text-muted-foreground">Archived</span>;
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${location.is_active ? "bg-success/10 text-success" : "bg-surface-muted text-muted-foreground"}`}>
    {location.is_active ? "Active" : "Inactive"}
  </span>;
}

export function LocationItem({ location, intervals, countryName, mobile }: {
  location: AdminLocation; intervals: OpeningInterval[]; countryName?: string; mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLLIElement | null) => { rowRef.current = element; },
    tabIndex: 0,
    "aria-label": `Edit location ${location.name}`,
    onClick: () => setOpen(true),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
    },
  };
  const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  const country = countryName ? `${countryFlag(location.country_code ?? "")} ${countryName}` : "Not specified";

  return <>
    {mobile ? <li {...rowProps} className={`px-3 py-3 ${hover}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold text-foreground">{location.name}</span><Status location={location} />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{[location.city, countryName].filter(Boolean).join(", ") || "Location details not specified"}</p>
    </li> : <tr {...rowProps} className={hover}>
      <td className="min-w-40 px-3 py-3 align-top"><p className="font-semibold text-foreground">{location.name}</p>
        {location.address_line1 && <p className="mt-0.5 text-xs text-muted-foreground">{location.address_line1}</p>}</td>
      <td className="px-3 py-3 align-top"><Status location={location} /></td>
      <td className="min-w-36 px-3 py-3 align-top">{location.city && <p className="text-foreground">{location.city}</p>}<span>{country}</span></td>
      <td className="min-w-36 px-3 py-3 align-top">{location.timezone}</td>
      <td className="px-3 py-3 align-top">{location.currency}</td>
    </tr>}
    {open && createPortal(<LocationDialog location={location} intervals={intervals} open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) rowRef.current?.focus();
    }} />, document.body)}
  </>;
}
