import Link from "next/link";
import { AdminPageHeader, AdminToolbar } from "@/components/admin-page-controls";
import { listAdminLocationsWithReadiness } from "@/lib/admin/locations";
import { countries } from "@/lib/profile/countries";
import { LocationDialog } from "./location-dialog";
import { LocationItem } from "./location-item";

export const instant = false;

export default async function AdminLocationsPage({ searchParams }: {
  searchParams?: Promise<{ view?: string | string[] }>;
}) {
  const archived = (await searchParams)?.view === "archived";
  const locations = await listAdminLocationsWithReadiness(archived ? "archived" : "current");
  const rows = locations.map((location) => {
    const countryName = countries.find((entry) => entry.code === location.country_code)?.name;
    return { location, countryName };
  }).sort((a, b) => a.location.name.localeCompare(b.location.name) || a.location.id.localeCompare(b.location.id));

  return <>
    <AdminPageHeader title="Locations" description="Manage the club’s physical locations and their operating details." />
    <AdminToolbar primary={<Link href={archived ? "/admin/locations" : "/admin/locations?view=archived"}
        className="inline-flex min-h-9 items-center rounded-control px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {archived ? "Current locations" : "Archived"}
      </Link>} action={!archived ? <LocationDialog /> : undefined} />
    {rows.length === 0 ? <p className="rounded-control border border-border bg-surface px-4 py-6 text-sm text-muted-foreground">
      {archived ? "No archived locations." : "No locations found."}
    </p> : <>
      <div className="overflow-x-auto rounded-control border border-border bg-surface">
        <table className="w-full min-w-[1100px] text-left text-sm" aria-label={archived ? "Archived locations" : "Locations"}>
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
            <tr>{["Location", "Status", "City / Country", "Timezone", "Currency", "Details", "Opening hours", "Courts", "Pricing", "Public booking"].map((label, index) =>
              <th key={label} scope="col" className={`px-3 py-3 whitespace-nowrap ${index >= 5 && index <= 8 ? "text-center" : ""}`}>{label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ location, countryName }) => <LocationItem key={`${location.id}-${location.updated_at}`}
              location={location} missing={location.missing} countryName={countryName} />)}
          </tbody>
        </table>
      </div>
    </>}
  </>;
}
