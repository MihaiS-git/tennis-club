"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ActivityOptions } from "@/lib/bookings/activity-service";
import { activityHref, type ActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";

export function ActivityControls({ scope, query, options, staff }: {
  scope: ActivityScope; query: ActivityQuery; options: ActivityOptions; staff: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const queryString = activityHref(scope, query).split("?")[1];
  const currentQuery = useRef(queryString);
  useEffect(() => { currentQuery.current = queryString; }, [queryString]);

  function navigate(key: string, value: string) {
    const params = new URLSearchParams(currentQuery.current);
    if (value) params.set(key, value); else params.delete(key);
    if (key === "location") params.delete("court");
    params.delete("page");
    currentQuery.current = params.toString();
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  // Courts are scoped to the selected location; a court from another location is not active.
  const locationCourts = query.location ? options.courts.filter((court) => court.location_id === query.location) : [];
  const court = locationCourts.some((option) => option.id === query.court) ? query.court : undefined;
  const activeCount = [staff && query.type !== "all", query.status !== "all", query.location, court, query.from, query.to]
    .filter(Boolean).length;
  const hasFilters = activeCount > 0;
  // Filters collapse behind a toggle on small screens only; md+ always shows them.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const clearHref = activityHref(scope, { ...query, page: 1, type: staff ? "all" : "booking", status: "all",
    location: undefined, court: undefined, from: undefined, to: undefined });
  const controlClass = "min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:text-sm";
  const labelClass = "flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted-foreground md:w-40";

  return <div aria-label="Activity filters" aria-busy={pending} className="mb-4">
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}
      className="inline-flex min-h-10 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-sm font-semibold text-primary md:hidden">
      <SlidersHorizontal aria-hidden size={16} />Filters
      {hasFilters && <>{" "}<span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground">{activeCount}<span className="sr-only"> active</span></span></>}
    </button>
    <div id={panelId} className={`${open ? "grid" : "hidden"} mt-3 grid-cols-1 gap-3 rounded-card border border-border bg-surface p-3 min-[420px]:grid-cols-2 md:mt-0 md:flex md:flex-wrap md:items-end md:border-0 md:bg-transparent md:p-0`}>
      {staff && <label className={labelClass}>Type
        <select aria-label="Type" name="type" value={query.type} className={controlClass} onChange={(e) => navigate("type", e.target.value)}>
          <option value="all">All</option><option value="booking">Booking</option><option value="reservation">Reservation</option>
        </select>
      </label>}
      {scope === "history" && <label className={labelClass}>Status
        <select aria-label="Status" name="status" value={query.status} className={controlClass} onChange={(e) => navigate("status", e.target.value)}>
          <option value="all">All</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
        </select>
      </label>}
      <label className={labelClass}>Location
        <select aria-label="Location" name="location" value={query.location ?? ""} className={controlClass} onChange={(e) => navigate("location", e.target.value)}>
          <option value="">All locations</option>{options.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
      </label>
      <label className={labelClass}>Court
        <select aria-label="Court" name="court" value={court ?? ""} disabled={!query.location}
          className={`${controlClass} disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted-foreground`} onChange={(e) => navigate("court", e.target.value)}>
          {query.location ? <>
            <option value="">All courts</option>
            {locationCourts.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </> : <option value="">Select a location first</option>}
        </select>
      </label>
      <label className={labelClass}>Date from
        <input name="from" type="date" value={query.from ?? ""} className={controlClass} onChange={(e) => navigate("from", e.target.value)} />
      </label>
      <label className={labelClass}>Date to
        <input name="to" type="date" value={query.to ?? ""} className={controlClass} onChange={(e) => navigate("to", e.target.value)} />
      </label>
      {hasFilters && <Link href={clearHref} className="inline-flex min-h-10 items-center whitespace-nowrap px-1 text-sm font-semibold text-primary underline underline-offset-4 min-[420px]:col-span-2 md:px-2">Clear filters</Link>}
    </div>
  </div>;
}
