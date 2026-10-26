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
  const { programs, coaches, currencies, prices, filters, groups, total, page, totalPages } = await loadPricesPage({ ...params, search: params.q });
  const sortLinks = Object.fromEntries((["program", "currency", "duration", "amount"] as const).map(column => [column, {
    href: coachingListHref(path, filters, { sort: column, dir: filters.sort === column && filters.dir === "asc" ? "desc" : "asc", page: 1 }),
    direction: filters.sort === column ? filters.dir : undefined,
  }]));
  const rows = groups.flatMap(group => {
    const program = programs.find(program => program.id === group.program_id);
    const currency = currencies.find(currency => currency.currency === group.currency);
    return program && currency ? [{ program, currency, durationMinutes: group.duration_minutes }] : [];
  });
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Prices</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Every price is a lesson price/person: what each player pays for one complete lesson of that duration. Club prices apply
      club-wide to every coach offering the program, in each currency, and are set separately for each duration and number of
      players the program allows; no price is calculated from another. A lesson is charged in its location’s currency, never
      converted. Coaches set their own individual Private and Semi-private prices, which replace the club price for that coach
      only. Group and Junior programs have club prices only; they are published on the Coaching page for information and paid at the club.
    </p>
    <ManagementTableToolbar searchLabel="Price search" placeholder="Program, coach name or email" controls={[
      { name: "currency", label: "Currency", options: [{ value: "", label: "All currencies" }, ...currencies.map(({ currency }) => ({ value: currency, label: currency }))] },
      { name: "program", label: "Program", searchable: true, options: [{ value: "", label: "All programs" }, ...programs.map(program => ({ value: program.id, label: program.name }))] },
      { name: "duration", label: "Duration", options: [{ value: "", label: "All durations" }, ...[...new Set(programs.flatMap(program => program.durations))].sort((a,b) => a-b).map(duration => ({ value: String(duration), label: formatCoachingDuration(duration) }))] },
      { name: "scope", resets: ["coach"], label: "Price scope", options: [{ value: "", label: "All prices" }, { value: "club", label: "Club default" }, { value: "coach", label: "Coach-specific" }] },
      ...filters.scope === "club" ? [] : [{ name: "coach", label: "Coach", options: [{ value: "", label: "All coaches" }, ...coaches.map(coach => ({ value: coach.user_id, label: `${coach.display_name} (${coach.email})` }))] }],
    ]} />
    <p className="mb-3 text-sm text-muted-foreground">{total} pricing {total === 1 ? "group" : "groups"}. Amount sorting uses the lowest matching entered price in each group; unset prices appear last. Compare amounts within a currency.</p>
    {currencies.length ? <PricesTable rows={rows} coaches={coaches} prices={prices} filters={filters} sortLinks={sortLinks}
      filtered={Boolean(filters.search || filters.currency || filters.program || filters.duration || filters.scope || filters.coach)} />
      : <p className="text-sm text-muted-foreground">No locations yet. Coaching prices are set in the currencies the club’s locations use.</p>}
    <div className="mt-6"><Pagination currentPage={page} totalPages={totalPages} buildHref={next => coachingListHref(path, filters, { page: next })} /></div>
  </>;
}
