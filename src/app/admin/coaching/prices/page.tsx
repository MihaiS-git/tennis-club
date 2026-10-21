import { ManagementTableToolbar } from "@/components/management-table-toolbar";
import { Pagination } from "@/components/pagination";
import { loadPricesPage } from "@/lib/coaching/admin-lists";
import { coachingListHref } from "@/lib/coaching/admin-filters";
import { formatCoachingDuration } from "@/lib/coaching/validation";
import { PricesTable } from "./prices-table";

export const instant = false;
const path = "/admin/coaching/prices";
export default async function AdminCoachingPricesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { programs, coaches, locations, prices, filters, groups, total, page, totalPages } = await loadPricesPage({ ...params, search: params.q });
  const sortLinks = Object.fromEntries((["program", "location", "duration", "amount"] as const).map(column => [column, {
    href: coachingListHref(path, filters, { sort: column, dir: filters.sort === column && filters.dir === "asc" ? "desc" : "asc", page: 1 }),
    direction: filters.sort === column ? filters.dir : undefined,
  }]));
  const rows = groups.flatMap(group => {
    const program = programs.find(program => program.id === group.program_id);
    const location = locations.find(location => location.id === group.location_id);
    return program && location ? [{ program, location, durationMinutes: group.duration_minutes }] : [];
  });
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Prices</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Club prices apply to every coach at a location. An individual coach price replaces the club price for that coach only.
      Amounts are in the location’s currency; coaches cannot change prices.
    </p>
    <ManagementTableToolbar searchLabel="Price search" placeholder="Program, coach name or email" controls={[
      { name: "location", label: "Location", options: [{ value: "", label: "All locations" }, ...locations.map(location => ({ value: location.id, label: location.name }))] },
      { name: "program", label: "Program", searchable: true, options: [{ value: "", label: "All programs" }, ...programs.map(program => ({ value: program.id, label: program.name }))] },
      { name: "duration", label: "Duration", options: [{ value: "", label: "All durations" }, ...[...new Set(programs.flatMap(program => program.durations))].sort((a,b) => a-b).map(duration => ({ value: String(duration), label: formatCoachingDuration(duration) }))] },
      { name: "scope", resets: ["coach"], label: "Price scope", options: [{ value: "", label: "All prices" }, { value: "club", label: "Club default" }, { value: "coach", label: "Coach-specific" }] },
      ...filters.scope === "club" ? [] : [{ name: "coach", label: "Coach", options: [{ value: "", label: "All coaches" }, ...coaches.map(coach => ({ value: coach.user_id, label: `${coach.display_name} (${coach.email})` }))] }],
    ]} />
    <p className="mb-3 text-sm text-muted-foreground">{total} pricing {total === 1 ? "group" : "groups"}. Amount sorting uses the lowest matching entered price in each group; unset prices appear last. Compare amounts within a currency.</p>
    {locations[0] ? <PricesTable location={locations[0]} programs={programs} coaches={coaches} prices={prices} groups={rows} filters={filters} sortLinks={sortLinks} />
      : <p className="text-sm text-muted-foreground">No locations yet. Coaching prices are set per location and its currency.</p>}
    <div className="mt-6"><Pagination currentPage={page} totalPages={totalPages} buildHref={next => coachingListHref(path, filters, { page: next })} /></div>
  </>;
}
