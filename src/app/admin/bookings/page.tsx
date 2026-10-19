import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { Pagination } from "@/components/pagination";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listAdminBookingCoachFilterOptions, listAdminBookingFilterOptions, listAdminBookings } from "@/lib/bookings/admin-details";
import { adminBookingQueryString, adminBookingsHref, parseAdminBookingQuery } from "@/lib/bookings/admin-query";
import { BookingRow } from "./booking-row";
import { BookingsToolbar } from "./bookings-toolbar";

export const metadata: Metadata = { title: "Bookings | Tennis Club" };
export const instant = false;

export default async function AdminBookingsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveAdmin();
  const parsed = parseAdminBookingQuery(await searchParams);
  const [locations, coaches] = await Promise.all([listAdminBookingFilterOptions(),
    parsed.type === "coaching" ? listAdminBookingCoachFilterOptions() : Promise.resolve([])]);
  // Unknown locations and courts outside the selected location are dropped, never queried.
  const location = locations.find((item) => item.id === parsed.location);
  const query = { ...parsed, coach: coaches.some((coach) => coach.id === parsed.coach) ? parsed.coach : "", location: location?.id ?? "", court: location?.courts.some((court) => court.id === parsed.court) ? parsed.court : "" };
  const result = await listAdminBookings(query);
  const listQuery = adminBookingQueryString({ ...query, page: result.page });
  const hasFilters = Boolean(query.q || query.type !== "all" || query.status !== "all" || query.location || query.from || query.to);
  return <>
    <AdminPageHeader title="Bookings" description="Search and review customer bookings across all locations, including past and cancelled bookings." />
    <BookingsToolbar locations={locations} coaches={coaches} />
    <p className="mb-3 text-sm text-muted-foreground">{result.total} {result.total === 1 ? "booking" : "bookings"} · Times in each location’s timezone</p>
    {result.rows.length === 0 ? <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
      {hasFilters ? "No bookings match these filters." : "No bookings yet."}
    </p> : <>
      <ul aria-label="Bookings" className="space-y-3 lg:hidden">
        {result.rows.map((booking) => <BookingRow key={booking.id} booking={booking} listQuery={listQuery} mobile />)}
      </ul>
      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface lg:block">
        <table aria-label="Bookings" className="w-full text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
            <tr>{([
              ["Reference", null], ["Type", null], ["Customer", null], ["Location and court", null], ["Scheduled", "scheduled"],
              ["Status", null], ["Total", null], ["Created", "created"],
            ] as const).map(([label, sort]) => {
              const active = query.sort === sort;
              const Icon = active ? query.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
              return <th key={label} scope="col" className={`whitespace-nowrap px-3 py-2.5 ${label === "Total" ? "text-right" : ""}`}
                aria-sort={sort ? active ? query.dir === "asc" ? "ascending" : "descending" : "none" : undefined}>
                {sort ? <Link scroll={false} href={adminBookingsHref({ ...query, sort, dir: active && query.dir === "desc" ? "asc" : "desc" }, 1)}
                  className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">
                  {label}<Icon size={14} aria-hidden /></Link> : label}
              </th>;
            })}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.rows.map((booking) => <BookingRow key={booking.id} booking={booking} listQuery={listQuery} />)}
          </tbody>
        </table>
      </div>
    </>}
    {result.totalPages > 1 && <div className="mt-6"><Pagination currentPage={result.page} totalPages={result.totalPages}
      buildHref={(page) => adminBookingsHref(query, page)} /></div>}
  </>;
}
