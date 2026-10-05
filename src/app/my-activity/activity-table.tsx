import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { activityHref, type ActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";

export function ActivityTable({ scope, query, staff, children }: {
  scope: ActivityScope; query: ActivityQuery; staff: boolean; children: ReactNode;
}) {
  const columns: { label: string; sort?: ActivityQuery["sort"] }[] = [
    ...(staff ? [{ label: "Type", sort: "type" as const }] : []),
    { label: "Location", sort: "location" },
    { label: "Court", sort: "court" },
    { label: "Date", sort: "datetime" },
    { label: "Time" },
    { label: "Duration", sort: "duration" },
    { label: "Total" },
    ...(scope === "history" ? [{ label: "Status", sort: "status" as const }] : []),
  ];

  return <div className="overflow-x-auto rounded-card border border-border bg-surface">
    <table aria-label={scope === "history" ? "Booking history" : "Upcoming bookings and reservations"}
      className="w-full min-w-[800px] text-left font-sans text-sm">
      <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
        <tr>{columns.map(({ label, sort }) => {
          const active = query.sort === sort;
          const Icon = active ? query.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
          const direction = active ? query.direction === "asc" ? "desc" : "asc"
            : sort === "datetime" && scope === "history" ? "desc" : "asc";
          return <th key={label} scope="col" className="whitespace-nowrap px-3 py-3"
            aria-sort={sort ? active ? query.direction === "asc" ? "ascending" : "descending" : "none" : undefined}>
            {sort ? <Link href={activityHref(scope, { ...query, sort, direction }, 1)} scroll={false}
              aria-label={sort === "datetime" ? "Date/time" : undefined}
              className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
              {label}<Icon aria-hidden="true" size={14} />
            </Link> : label}
          </th>;
        })}</tr>
      </thead>
      <tbody className="divide-y divide-border">{children}</tbody>
    </table>
  </div>;
}
