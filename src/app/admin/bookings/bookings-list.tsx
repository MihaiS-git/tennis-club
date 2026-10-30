import { PendingLink } from "@/components/navigation-pending";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Pagination } from "@/components/pagination";
import type { AdminBookingListItem } from "@/lib/bookings/admin-details";
import { adminBookingQueryString, type AdminBookingQuery } from "@/lib/bookings/admin-query";
import type { CoachBookingListItem } from "@/lib/bookings/coach-bookings";
import { BookingRow, type ListScope } from "./booking-row";

// The shared List results for Admins and Coaches: server-sorted, URL-backed and paginated.
// Coaches have no Total column; their records carry no price. Their Actions column
// offers Reschedule lesson and Cancel lesson on their own eligible lessons.
export function BookingsList({ result, query, href, scope = "admin" }: {
  result: { rows: (AdminBookingListItem | CoachBookingListItem)[]; page: number; total: number; totalPages: number };
  query: AdminBookingQuery; href: (query: AdminBookingQuery, page?: number) => string; scope?: ListScope;
}) {
  const listQuery = adminBookingQueryString({ ...query, page: result.page });
  const hasFilters = Boolean(query.q || query.type !== "all" || query.status !== "all" || query.location || query.from || query.to);
  const columns = ([
    ["Reference", null], ["Type", null], ["Customer or staff", null], ["Location and court", null], ["Scheduled", "scheduled"],
    ["Status", null], ["Total", null], ["Created", "created"], ["Actions", null],
  ] as const).filter(([label]) => scope === "admin" || label !== "Total");
  return <>
    <p className="mb-3 text-sm text-muted-foreground">{result.total} {result.total === 1 ? "result" : "results"} · Times in each location’s timezone</p>
    {result.rows.length === 0 ? <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
      {hasFilters ? "No bookings or reservations match these filters." : "No bookings or reservations yet."}
    </p> : <>
      <ul aria-label="Bookings and reservations" className="space-y-3 lg:hidden">
        {result.rows.map((booking) => <BookingRow key={`${booking.kind}:${booking.id}`} booking={booking} listQuery={listQuery} mobile scope={scope} />)}
      </ul>
      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface lg:block">
        <table aria-label="Bookings and reservations" className="w-full text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
            <tr>{columns.map(([label, sort]) => {
              const active = query.sort === sort;
              const Icon = active ? query.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
              return <th key={label} scope="col" className={`whitespace-nowrap px-3 py-2.5 ${label === "Total" ? "text-right" : ""}`}
                aria-sort={sort ? active ? query.dir === "asc" ? "ascending" : "descending" : "none" : undefined}>
                {sort ? <PendingLink scroll={false} href={href({ ...query, sort, dir: active && query.dir === "desc" ? "asc" : "desc" }, 1)}
                  className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">
                  {label}<Icon size={14} aria-hidden /></PendingLink> : label}
              </th>;
            })}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.rows.map((booking) => <BookingRow key={`${booking.kind}:${booking.id}`} booking={booking} listQuery={listQuery} scope={scope} />)}
          </tbody>
        </table>
      </div>
    </>}
    {result.totalPages > 1 && <div className="mt-6"><Pagination currentPage={result.page} totalPages={result.totalPages}
      buildHref={(page) => href(query, page)} /></div>}
  </>;
}
