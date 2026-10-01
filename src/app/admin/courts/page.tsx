import Link from "next/link";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { z } from "zod";
import { listAdminCourtCoverage } from "@/lib/admin/court-coverage";
import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminLocations } from "@/lib/admin/locations";
import { CourtItem } from "./court-item";
import { CourtsToolbar } from "./courts-toolbar";
import { courtInventorySchema, selectLocationCourts } from "./inventory";

export const instant = false;

export default async function AdminCourtsPage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const params = await searchParams;
  const options = courtInventorySchema.parse(params ?? {});
  const [courts, locations, periods] = await Promise.all([listAdminCourts(), listAdminLocations(), listAdminCourtCoverage()]);
  const requested = z.uuid().safeParse(params?.location);
  const selected = requested.success ? locations.find((location) => location.id === requested.data) ?? locations[0] : locations[0];
  const locationCourts = selected ? selectLocationCourts(courts, selected.id, options) : [];
  const locationCourtCount = selected ? courts.filter((court) => court.location_id === selected.id).length : 0;
  const locationChoices = locations.map(({ id, name, is_active }) => ({ id, name, is_active }));
  const hasFilters = Boolean(options.status || options.surface || options.environment);
  function sortHref(column: typeof options.sort) {
    const query = new URLSearchParams();
    if (selected) query.set("location", selected.id);
    if (options.status) query.set("status", options.status);
    if (options.surface) query.set("surface", options.surface);
    if (options.environment) query.set("environment", options.environment);
    query.set("sort", column);
    query.set("dir", options.sort === column && options.dir === "asc" ? "desc" : "asc");
    return `/admin/courts?${query}`;
  }
  return <>
    <AdminPageHeader title="Courts" description="Manage the club’s court inventory by location, including inactive courts." />
    <CourtsToolbar locations={locationChoices} selectedId={selected?.id} />
    {locations.length === 0 && <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">
      <Link href="/admin/locations" className="font-semibold text-primary underline">Create a location</Link> before adding courts.
    </div>}
    {selected && <section aria-label={`${selected.name} courts`}>
          {locationCourts.length === 0 ? <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">{hasFilters && locationCourtCount ? "No courts match these filters at this location." : "No courts at this location."}</div> : <>
            <div className="space-y-4 lg:hidden">
              {locationCourts.map((court) => <CourtItem key={court.id} court={court} locations={locationChoices} periods={periods.filter((period) => period.court_id === court.id)} mobile />)}
            </div>
            <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
              <table className="w-full table-fixed text-left font-sans text-sm" aria-label={`${selected.name} courts`}>
                <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
                  <tr>{(["name", "status", "surface", "environment", "lighting"] as const).map((column) => {
                    const active = options.sort === column;
                    const Icon = active ? options.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
                    return <th key={column} scope="col" aria-sort={active ? options.dir === "asc" ? "ascending" : "descending" : "none"} className="px-3 py-3">
                      <Link href={sortHref(column)} scroll={false} className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
                        {column[0].toUpperCase() + column.slice(1)}<Icon aria-hidden="true" size={14} />
                      </Link>
                    </th>;
                  })}</tr>
                </thead>
                {locationCourts.map((court) => <CourtItem key={court.id} court={court} locations={locationChoices} periods={periods.filter((period) => period.court_id === court.id)} />)}
              </table>
            </div>
          </>}
    </section>}
  </>;
}
