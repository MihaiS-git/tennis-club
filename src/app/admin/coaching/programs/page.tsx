import { ManagementTableToolbar } from "@/components/management-table-toolbar";
import { Pagination } from "@/components/pagination";
import { loadProgramsPage } from "@/lib/coaching/admin-lists";
import { coachingListHref } from "@/lib/coaching/admin-filters";
import { coachingProgramTypeLabels } from "@/lib/coaching/validation";
import { ProgramDialog } from "./program-dialog";
import { ProgramsTable } from "./programs-table";

export const instant = false;
const path = "/admin/coaching/programs";

export default async function AdminCoachingProgramsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { programs, locations, prices, filters, total, page, totalPages } = await loadProgramsPage({ ...params, search: params.q });
  const sortLinks = Object.fromEntries((["name", "type", "status"] as const).map(column => [column, {
    href: coachingListHref(path, filters, { sort: column, dir: filters.sort === column && filters.dir === "asc" ? "desc" : "asc", page: 1 }),
    direction: filters.sort === column ? filters.dir : undefined,
  }]));
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Programs</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Coaching offerings shown on the public Coaching page while active. Club prices are set per duration and location here or under Prices; individual coach prices under Prices.
    </p>
    <ManagementTableToolbar searchLabel="Program search" placeholder="Search by program name" action={<ProgramDialog locations={locations} />} controls={[
      { name: "type", label: "Program type", options: [{ value: "", label: "All types" }, ...Object.entries(coachingProgramTypeLabels).map(([value, label]) => ({ value, label }))] },
      { name: "status", label: "Status", options: [{ value: "", label: "All statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] },
    ]} />
    <p className="mb-3 text-sm text-muted-foreground">{total} {total === 1 ? "program" : "programs"}</p>
    <ProgramsTable programs={programs} locations={locations} prices={prices} sortLinks={sortLinks} filtered={Boolean(filters.search || filters.type || filters.status)} />
    <div className="mt-6"><Pagination currentPage={page} totalPages={totalPages} buildHref={next => coachingListHref(path, filters, { page: next })} /></div>
  </>;
}
