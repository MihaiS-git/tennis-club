import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { activityHref, type ActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";

// Below md the table becomes a stacked list: the header turns into sort chips and
// each row wraps into three lines (when · status / where · total / duration · type).
// Line breaks are the row's ::before/::after pseudo-elements, so cells stay single-sourced.
export function ActivityTable({ scope, query, children }: {
  scope: ActivityScope; query: ActivityQuery; children: ReactNode;
}) {
  const columns: { label: string; sort?: ActivityQuery["sort"]; align?: "right" }[] = [
    { label: "Type", sort: "type" },
    { label: "Location", sort: "location" },
    { label: "Court", sort: "court" },
    { label: "Date", sort: "datetime" },
    { label: "Time" },
    { label: "Duration", sort: "duration" },
    { label: "Total", align: "right" },
    scope === "history" ? { label: "Status", sort: "status" as const } : { label: "Status" },
  ];

  return <div className="overflow-x-auto rounded-card border border-border bg-surface">
    <table aria-label={scope === "history" ? "Booking history" : "Upcoming bookings and reservations"}
      className="w-full text-left font-sans text-sm max-md:block md:min-w-[800px]">
      <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground max-md:block">
        <tr className="max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-1.5 max-md:px-4 max-md:py-2.5 max-md:before:mr-1 max-md:before:content-['Sort']">{columns.map(({ label, sort, align }) => {
          const active = query.sort === sort;
          const Icon = active ? query.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
          const direction = active ? query.direction === "asc" ? "desc" : "asc"
            : sort === "datetime" && scope === "history" ? "desc" : "asc";
          return <th key={label} scope="col" className={`whitespace-nowrap px-3 py-3 max-md:p-0 ${align === "right" ? "md:text-right" : ""} ${sort ? "" : "max-md:hidden"}`}
            aria-sort={sort ? active ? query.direction === "asc" ? "ascending" : "descending" : "none" : undefined}>
            {sort ? <Link href={activityHref(scope, { ...query, sort, direction }, 1)} scroll={false}
              aria-label={sort === "datetime" ? "Date/time" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary max-md:min-h-8 max-md:rounded-full max-md:border max-md:px-2.5 ${active ? "text-primary max-md:border-primary max-md:bg-surface" : "max-md:border-border"}`}>
              {label}<Icon aria-hidden="true" size={14} />
            </Link> : label}
          </th>;
        })}</tr>
      </thead>
      <tbody className="divide-y divide-border max-md:block">{children}</tbody>
    </table>
  </div>;
}

const cell = "px-3 py-3 max-md:p-0";
const separated = "max-md:before:mr-1.5 max-md:before:content-['·']";

export function ActivityRow({ label, type, typeDetail, location, court, date, time, duration, total, status, onOpen }: {
  label: string; type: string; typeDetail?: string; location: string; court: string; date: string; time: string;
  duration: string; total: string; status: ReactNode; onOpen: (row: HTMLTableRowElement) => void;
}) {
  return <tr tabIndex={0} aria-label={label}
    onClick={(event) => onOpen(event.currentTarget)}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(event.currentTarget); }
    }}
    className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-y-1 max-md:px-4 max-md:py-3 max-md:before:order-4 max-md:before:basis-full max-md:before:content-[''] max-md:after:order-8 max-md:after:basis-full max-md:after:content-['']">
    <td className={`${cell} md:w-56 md:min-w-48 md:max-w-56 max-md:order-10 max-md:min-w-0 max-md:flex-1 max-md:pl-1.5 max-md:text-xs max-md:text-muted-foreground`}>
      <span className={separated}>{type}</span>
      {typeDetail && <span className="block [overflow-wrap:anywhere] text-xs font-normal text-muted-foreground md:mt-0.5">{typeDetail}</span>}
    </td>
    <td className={`${cell} font-semibold text-primary max-md:order-5 max-md:min-w-0 max-md:truncate max-md:font-normal max-md:text-foreground`}>{location}</td>
    <td className={`${cell} max-md:order-6 max-md:ml-1.5 max-md:text-foreground ${separated}`}>{court}</td>
    <td className={`whitespace-nowrap ${cell} max-md:order-1 max-md:font-semibold max-md:text-primary`}>{date}</td>
    <td className={`whitespace-nowrap ${cell} tabular-nums max-md:order-2 max-md:ml-1.5 max-md:font-semibold max-md:text-primary ${separated}`}>{time}</td>
    <td className={`whitespace-nowrap ${cell} tabular-nums max-md:order-9 max-md:text-xs max-md:text-muted-foreground`}>{duration}</td>
    <td className={`whitespace-nowrap ${cell} tabular-nums md:text-right max-md:order-7 max-md:ml-auto max-md:pl-3 max-md:font-semibold`}>{total}</td>
    <td className={`${cell} max-md:order-3 max-md:ml-auto max-md:pl-3`}>{status}</td>
  </tr>;
}
