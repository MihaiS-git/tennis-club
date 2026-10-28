import { ManagementTableToolbar } from "@/components/management-table-toolbar";
import { Pagination } from "@/components/pagination";
import { loadCoachesPage } from "@/lib/coaching/admin-lists";
import { coachingListHref } from "@/lib/coaching/admin-filters";
import { CoachesTable } from "./coaches-table";

export const instant = false;
const path = "/admin/coaching/coaches";

export default async function AdminCoachesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { coaches, locations, programs, prices, filters, total, page, totalPages } = await loadCoachesPage({ ...params, search: params.q });
  // Sorting is chosen from the column headings; "created" remains a supported URL sort without a column.
  const sortLinks = Object.fromEntries((["name", "email", "status", "profile"] as const).map(value => [value, {
    href: coachingListHref(path, filters, { sort: value, dir: filters.sort === value && filters.dir === "asc" ? "desc" : "asc", page: 1 }),
    direction: filters.sort === value ? filters.dir : undefined,
  }]));
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Coaches</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Manage every account with the Coach role and its optional coaching profile. Public coaching requires an active account and a public, unarchived profile.</p>
    <ManagementTableToolbar searchLabel="Coach search" placeholder="Search by name or email" controls={[
      { name: "status", label: "Account status", options: [{ value: "", label: "All accounts" }, { value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }] },
      { name: "profile", label: "Profile", options: [{ value: "", label: "All profiles" }, { value: "configured", label: "Configured" }, { value: "not-configured", label: "Not configured" }, { value: "archived", label: "Archived" }] },
      { name: "visibility", label: "Visibility", options: [{ value: "", label: "All visibility" }, { value: "public", label: "Public" }, { value: "private", label: "Hidden" }] },
    ]} />
    <p className="mb-3 text-sm text-muted-foreground">{total} {total === 1 ? "coach" : "coaches"}</p>
    <CoachesTable coaches={coaches} locations={locations} programs={programs} prices={prices} sortLinks={sortLinks}
      filtered={Boolean(filters.search || filters.status || filters.profile || filters.visibility)} />
    <div className="mt-6"><Pagination currentPage={page} totalPages={totalPages} buildHref={next => coachingListHref(path, filters, { page: next })} /></div>
  </>;
}
