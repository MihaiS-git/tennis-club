import Link from "next/link";
import { RowLink } from "@/components/row-link";
import { NavigationLink } from "@/components/navigation-pending";
import type { AdminLocation } from "@/lib/admin/locations";
import { countryFlag } from "@/lib/profile/countries";
import { ChevronRight } from "lucide-react";
import { configurationAreas, ConfigurationIndicator, LocationStatus, PublicationStatus } from "./configuration-status";

export function LocationItem({ location, missing, countryName, mobile = false }: {
  location: AdminLocation; missing: string[]; countryName?: string; mobile?: boolean;
}) {
  const href = `/admin/locations/${location.id}`;
  const country = countryName ? `${countryFlag(location.country_code ?? "")} ${countryName}` : "Not specified";
  const cell = "px-3 py-2.5 align-middle";
  const setup = configurationAreas.map((area) => <Link key={area.target} href={`${href}?tab=${area.target}`}
    className="relative z-10 inline-flex size-8 items-center justify-center rounded-control hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus">
    <ConfigurationIndicator area={area} missing={missing} />
  </Link>);
  if (mobile) return <article className="min-w-0 rounded-card border border-border bg-surface p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <NavigationLink pendingPlacement="after" href={href} className="break-words font-semibold text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{location.name}</NavigationLink>
        <p className="mt-0.5 text-sm text-muted-foreground">{[location.city, country].filter(Boolean).join(", ")}</p>
        <p className="text-xs text-muted-foreground">{location.timezone} · {location.currency}</p>
      </div>
      <LocationStatus location={location} />
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <div className="flex items-center gap-1"><span className="mr-1 text-xs text-muted-foreground">Setup</span>{setup}</div>
      <Link href={`${href}?tab=public-booking`} className="relative z-10 rounded-full focus-visible:outline-2 focus-visible:outline-focus"><PublicationStatus location={location} missing={missing} /></Link>
    </div>
  </article>;
  return <tr className="relative cursor-pointer hover:bg-surface-muted focus-within:bg-surface-muted">
    <td className={`${cell} min-w-44`}><RowLink href={href}
      className="font-semibold text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{location.name}</RowLink>
      {location.address_line1 && <p className="mt-0.5 text-xs text-muted-foreground">{location.address_line1}</p>}</td>
    <td className={cell}><LocationStatus location={location} /></td>
    <td className={`${cell} min-w-40`}>
      <p>{location.city && <span>{location.city}</span>}{location.city && ", "}<span>{country}</span></p>
      <p className="mt-0.5 text-xs text-muted-foreground"><span>{location.timezone}</span> · <span>{location.currency}</span></p>
    </td>
    <td className={cell}><div className="flex items-center gap-1">{setup}</div></td>
    <td className={`${cell} whitespace-nowrap`}><div className="flex items-center justify-between gap-3">
      <Link href={`${href}?tab=public-booking`} className="relative z-10 rounded-full focus-visible:outline-2 focus-visible:outline-focus"><PublicationStatus location={location} missing={missing} /></Link>
      <Link href={href} aria-label={`Manage location ${location.name}`} title="Manage location"
        className="relative z-10 inline-flex size-8 items-center justify-center rounded-control text-muted-foreground hover:bg-surface hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"><ChevronRight aria-hidden="true" className="size-4" /></Link>
    </div></td>
  </tr>;
}
