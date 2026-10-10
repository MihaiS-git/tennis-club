"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AdminLocation } from "@/lib/admin/locations";
import { countryFlag } from "@/lib/profile/countries";
import { configurationAreas, ConfigurationIndicator, LocationStatus, publicationState } from "./configuration-status";

export function LocationItem({ location, missing, countryName }: {
  location: AdminLocation; missing: string[]; countryName?: string;
}) {
  const router = useRouter();
  const href = `/admin/locations/${location.id}`;
  const country = countryName ? `${countryFlag(location.country_code ?? "")} ${countryName}` : "Not specified";
  const cell = "px-3 py-3 align-top";
  return <tr tabIndex={0} aria-label={`Manage location ${location.name}`}
    onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      router.push(href);
    }}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); router.push(href); }
    }}
    className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus">
    <td className={`${cell} min-w-40`}><Link href={href}
      className="font-semibold text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{location.name}</Link>
      {location.address_line1 && <p className="mt-0.5 text-xs text-muted-foreground">{location.address_line1}</p>}</td>
    <td className={cell}><LocationStatus location={location} /></td>
    <td className={`${cell} min-w-36`}>{location.city && <p>{location.city}</p>}<span>{country}</span></td>
    <td className={`${cell} whitespace-nowrap`}>{location.timezone}</td>
    <td className={cell}>{location.currency}</td>
    {configurationAreas.map((area) => <td key={area.target} className={`${cell} text-center`}>
      <Link href={`${href}?tab=${area.target}`} className="inline-flex rounded-control focus-visible:outline-2 focus-visible:outline-focus">
        <ConfigurationIndicator area={area} missing={missing} />
      </Link>
    </td>)}
    <td className={`${cell} whitespace-nowrap`}><Link href={`${href}?tab=public-booking`} className="hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{publicationState(location, missing)}</Link>
      <Link href={href} aria-label={`Manage location ${location.name}`} className="mt-1 block text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus">Manage location</Link>
    </td>
  </tr>;
}
