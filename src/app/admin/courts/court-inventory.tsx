"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { AdminCourt } from "@/lib/admin/courts";
import type { AdminLocation } from "@/lib/admin/locations";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { CourtItem } from "./court-item";
import { CourtsToolbar } from "./courts-toolbar";
import { courtInventorySchema, selectLocationCourts } from "./inventory";

export function CourtInventory({ location: selected, courts, locations, periods, scoped = false }: {
  location: Pick<AdminLocation, "id" | "name">;
  courts: AdminCourt[];
  locations: Pick<AdminLocation, "id" | "name" | "is_active">[];
  periods: CoveragePeriod[];
  scoped?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = (key: string) => {
    const values = searchParams.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const options = courtInventorySchema.parse({
    status: value("status"), surface: value("surface"), environment: value("environment"), sort: value("sort"), dir: value("dir"),
  });
  const visibleIds = new Set(selectLocationCourts(courts, selected.id, options).map(({ id }) => id));
  const locationCourts = selectLocationCourts(courts, selected.id, { sort: options.sort, dir: options.dir });
  const locationCourtCount = locationCourts.length;
  const hasFilters = Boolean(options.status || options.surface || options.environment);
  function sortHref(column: typeof options.sort) {
    const query = new URLSearchParams(searchParams);
    if (scoped) query.set("tab", "courts");
    else query.set("location", selected.id);
    query.set("sort", column);
    query.set("dir", options.sort === column && options.dir === "asc" ? "desc" : "asc");
    return `${pathname}?${query}`;
  }
  return <>
    <CourtsToolbar locations={locations} selectedId={selected.id} scoped={scoped} />
    <section aria-label={`${selected.name} courts`}>
      {visibleIds.size === 0 ? <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">{hasFilters && locationCourtCount ? "No courts match these filters at this location." : "No courts at this location."}</div> : null}
      <div hidden={visibleIds.size === 0} className="space-y-4 lg:hidden">
        {locationCourts.map((court) => <CourtItem key={court.id} court={court} visible={visibleIds.has(court.id)} locations={locations} periods={periods.filter((period) => period.court_id === court.id)} mobile />)}
      </div>
      <div hidden={visibleIds.size === 0} className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
        <table className="w-full table-fixed text-left font-sans text-sm" aria-label={`${selected.name} courts`}>
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
            <tr>{(["name", "status", "surface", "environment", "lighting"] as const).map((column) => {
              const active = options.sort === column;
              const Icon = active ? options.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
              return <th key={column} scope="col" aria-sort={active ? options.dir === "asc" ? "ascending" : "descending" : "none"} className="px-3 py-3">
                <Link href={sortHref(column)} scroll={false} onClick={scoped ? (event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  window.history.pushState(null, "", sortHref(column));
                } : undefined} className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
                  {column[0].toUpperCase() + column.slice(1)}<Icon aria-hidden="true" size={14} />
                </Link>
              </th>;
            })}</tr>
          </thead>
          {locationCourts.map((court) => <CourtItem key={court.id} court={court} visible={visibleIds.has(court.id)} locations={locations} periods={periods.filter((period) => period.court_id === court.id)} />)}
        </table>
      </div>
    </section>
  </>;
}
