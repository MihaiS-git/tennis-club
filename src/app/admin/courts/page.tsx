import Link from "next/link";
import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminLocations } from "@/lib/admin/locations";
import { courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { CourtDialog } from "./court-dialog";

function CourtStatus({ active }: { active: boolean }) {
  return <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${active
    ? "bg-success-background text-success" : "bg-danger-background text-danger"}`}>
    {active ? "Active" : "Inactive"}
  </span>;
}

export default async function AdminCourtsPage() {
  const [courts, locations] = await Promise.all([listAdminCourts(), listAdminLocations()]);
  const locationChoices = locations.map(({ id, name, is_active }) => ({ id, name, is_active }));
  return <main className="flex-1 bg-background">
    <div className="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-12 lg:py-16">
      <header className="mb-8 md:mb-10">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Courts</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">Manage the club’s court inventory by location, including inactive courts.</p>
      </header>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{courts.length} {courts.length === 1 ? "court" : "courts"} across {locations.length} {locations.length === 1 ? "location" : "locations"}</p>
        <CourtDialog locations={locationChoices} />
      </div>
      {locations.length === 0 && <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">
        <Link href="/admin/locations" className="font-semibold text-primary underline">Create a location</Link> before adding courts.
      </div>}
      <div className="space-y-8">
        {locations.map((location) => {
          const locationCourts = courts.filter((court) => court.location_id === location.id);
          return <section key={location.id} aria-labelledby={`location-${location.id}`}>
            <header className="mb-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 id={`location-${location.id}`} className="font-heading text-2xl font-semibold text-foreground">{location.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{locationCourts.length} {locationCourts.length === 1 ? "court" : "courts"}{location.is_active ? "" : " · Inactive location"}</p>
              </div>
              <CourtDialog locations={locationChoices} locationId={location.id} />
            </header>
            {locationCourts.length === 0 ? <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">No courts at this location.</div> : <>
              <div className="space-y-3 lg:hidden">
                {locationCourts.map((court) => <article key={court.id} className="min-w-0 rounded-card border border-border bg-surface p-5">
                  <p className="break-words font-semibold text-foreground">{court.name}</p>
                  <dl className="mt-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
                    <dt className="text-muted-foreground">Status</dt><dd><CourtStatus active={court.is_active} /></dd>
                    <dt className="text-muted-foreground">Surface</dt><dd>{courtSurfaceLabels[court.surface]}</dd>
                    <dt className="text-muted-foreground">Environment</dt><dd>{courtEnvironmentLabels[court.environment]}</dd>
                    <dt className="text-muted-foreground">Lighting</dt><dd>{court.has_lighting ? "Floodlit" : "No lighting"}</dd>
                    <dt className="text-muted-foreground">Order</dt><dd>{court.display_order}</dd>
                  </dl>
                  <div className="mt-5 border-t border-border pt-4"><CourtDialog court={court} locations={locationChoices} /></div>
                </article>)}
              </div>
              <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
                <table className="w-full table-fixed text-left font-sans text-sm" aria-label={`${location.name} courts`}>
                  <thead className="border-b border-border text-xs font-semibold text-muted-foreground">
                    <tr>{["Name", "Status", "Surface", "Environment", "Lighting", "Order", "Actions"].map((label) => <th key={label} scope="col" className="px-4 py-4 lg:px-5">{label}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {locationCourts.map((court) => <tr key={court.id}>
                      <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5">{court.name}</td>
                      <td className="px-4 py-5 lg:px-5"><CourtStatus active={court.is_active} /></td>
                      <td className="px-4 py-5 lg:px-5">{courtSurfaceLabels[court.surface]}</td>
                      <td className="px-4 py-5 lg:px-5">{courtEnvironmentLabels[court.environment]}</td>
                      <td className="px-4 py-5 lg:px-5">{court.has_lighting ? "Floodlit" : "No lighting"}</td>
                      <td className="px-4 py-5 lg:px-5">{court.display_order}</td>
                      <td className="px-4 py-5 lg:px-5"><CourtDialog court={court} locations={locationChoices} /></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </>}
          </section>;
        })}
      </div>
    </div>
  </main>;
}
