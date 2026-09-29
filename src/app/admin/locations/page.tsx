import { Fragment } from "react";
import { listAdminLocations } from "@/lib/admin/locations";
import { listAdminOpeningHours } from "@/lib/admin/opening-hours";
import { LocationDialog } from "./location-dialog";
import { OpeningHours } from "./opening-hours";

function LocationStatus({ active }: { active: boolean }) {
  return <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${active
    ? "bg-success-background text-success" : "bg-danger-background text-danger"}`}>
    {active ? "Active" : "Inactive"}
  </span>;
}

export default async function AdminLocationsPage() {
  const [locations, openingHours] = await Promise.all([listAdminLocations(), listAdminOpeningHours()]);
  return <main className="flex-1 bg-background">
    <div className="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-12 lg:py-16">
      <header className="mb-8 md:mb-10">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Locations</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">Manage the club’s physical locations, including inactive locations.</p>
      </header>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{locations.length} {locations.length === 1 ? "location" : "locations"}</p>
        <LocationDialog />
      </div>
      {locations.length === 0 ? <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">No locations found.</div> : <>
        <div className="space-y-3 lg:hidden">
          {locations.map((location) => <article key={location.id} className="min-w-0 rounded-card border border-border bg-surface p-5">
            <p className="break-words font-semibold text-foreground">{location.name}</p>
            <dl className="mt-4 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Status</dt><dd><LocationStatus active={location.is_active} /></dd>
              <dt className="text-muted-foreground">City</dt><dd>{location.city ?? "—"}</dd>
              <dt className="text-muted-foreground">Timezone</dt><dd className="break-words">{location.timezone}</dd>
              <dt className="text-muted-foreground">Currency</dt><dd>{location.currency}</dd>
              <dt className="text-muted-foreground">Order</dt><dd>{location.display_order}</dd>
            </dl>
            <div className="mt-5 border-t border-border pt-4"><LocationDialog location={location} /></div>
            <div className="mt-4 border-t border-border pt-4"><OpeningHours locationId={location.id} intervals={openingHours.filter((interval) => interval.location_id === location.id)} /></div>
          </article>)}
        </div>
        <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
          <table className="w-full table-fixed text-left font-sans text-sm">
            <thead className="border-b border-border text-xs font-semibold text-muted-foreground">
              <tr>{["Name", "Status", "City", "Timezone", "Currency", "Order", "Actions"].map((label) => <th key={label} scope="col" className="px-4 py-4 lg:px-5">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {locations.map((location) => <Fragment key={location.id}><tr>
                <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5">{location.name}</td>
                <td className="px-4 py-5 lg:px-5"><LocationStatus active={location.is_active} /></td>
                <td className="break-words px-4 py-5 lg:px-5">{location.city ?? "—"}</td>
                <td className="break-words px-4 py-5 lg:px-5">{location.timezone}</td>
                <td className="px-4 py-5 lg:px-5">{location.currency}</td>
                <td className="px-4 py-5 lg:px-5">{location.display_order}</td>
                <td className="px-4 py-5 lg:px-5"><LocationDialog location={location} /></td>
              </tr><tr><td colSpan={7} className="px-5 pb-5"><OpeningHours locationId={location.id} intervals={openingHours.filter((interval) => interval.location_id === location.id)} /></td></tr></Fragment>)}
            </tbody>
          </table>
        </div>
      </>}
    </div>
  </main>;
}
