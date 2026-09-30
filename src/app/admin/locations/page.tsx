import Link from "next/link";
import { listAdminLocations } from "@/lib/admin/locations";
import { listAdminOpeningHours } from "@/lib/admin/opening-hours";
import { countries } from "@/lib/profile/countries";
import { LocationDialog } from "./location-dialog";
import { LocationItem } from "./location-item";

export default async function AdminLocationsPage({ searchParams }: {
  searchParams?: Promise<{ view?: string | string[] }>;
}) {
  const archived = (await searchParams)?.view === "archived";
  const [locations, openingHours] = await Promise.all([
    listAdminLocations(undefined, archived ? "archived" : "current"), listAdminOpeningHours(),
  ]);
  const rows = locations.map((location) => {
    const intervals = openingHours.filter((interval) => interval.location_id === location.id);
    const countryName = countries.find((entry) => entry.code === location.country_code)?.name;
    return { location, intervals, countryName };
  }).sort((a, b) => a.location.name.localeCompare(b.location.name) || a.location.id.localeCompare(b.location.id));

  return <>
    <header className="mb-8 md:mb-10">
      <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Locations</h1>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">Manage the club’s physical locations and their operating details.</p>
    </header>
    <div className="mb-5 flex flex-wrap items-center justify-end gap-3">
      <Link href={archived ? "/admin/locations" : "/admin/locations?view=archived"}
        className="inline-flex min-h-9 items-center rounded-control px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {archived ? "Current locations" : "Archived"}
      </Link>
      {!archived && <LocationDialog />}
    </div>
    {rows.length === 0 ? <p className="rounded-control border border-border bg-surface px-4 py-6 text-sm text-muted-foreground">
      {archived ? "No archived locations." : "No locations found."}
    </p> : <>
      <div className="overflow-hidden rounded-control border border-border bg-surface max-lg:hidden">
        <table className="w-full text-left text-sm" aria-label={archived ? "Archived locations" : "Locations"}>
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
            <tr>{["Location", "Status", "City / Country", "Timezone", "Currency"].map((label) =>
              <th key={label} scope="col" className="px-3 py-3">{label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ location, intervals, countryName }) => <LocationItem key={`${location.id}-${location.updated_at}`}
              location={location} intervals={intervals} countryName={countryName} />)}
          </tbody>
        </table>
      </div>
      <ul aria-label={archived ? "Archived locations" : "Locations"} className="divide-y divide-border rounded-control border border-border bg-surface lg:hidden">
        {rows.map(({ location, intervals, countryName }) => <LocationItem key={`${location.id}-${location.updated_at}`}
          location={location} intervals={intervals} countryName={countryName} mobile />)}
      </ul>
    </>}
  </>;
}
