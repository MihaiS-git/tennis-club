"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { AdminToolbar } from "@/components/admin-page-controls";
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

  const hasFilters = (staff && query.type !== "all") || query.status !== "all"
    || Boolean(query.location || query.court || query.from || query.to);
  const clearHref = activityHref(scope, { ...query, page: 1, type: staff ? "all" : "booking", status: "all",
    location: undefined, court: undefined, from: undefined, to: undefined });
  const controlClass = "min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-foreground";
  const labelClass = "flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-auto sm:min-w-36";

  return <div aria-label="Activity filters" aria-busy={pending}>
    <AdminToolbar primary={staff && <label className={labelClass}>Type
      <select aria-label="Type" name="type" value={query.type} className={controlClass} onChange={(e) => navigate("type", e.target.value)}>
        <option value="all">All</option><option value="booking">Booking</option><option value="reservation">Reservation</option>
      </select>
    </label>} filters={<>
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
        <select aria-label="Court" name="court" value={query.court ?? ""} className={controlClass} onChange={(e) => navigate("court", e.target.value)}>
          <option value="">All courts</option>{options.courts.filter((court) => !query.location || court.location_id === query.location)
            .map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
        </select>
      </label>
      <label className={labelClass}>Date from
        <input name="from" type="date" value={query.from ?? ""} className={controlClass} onChange={(e) => navigate("from", e.target.value)} />
      </label>
      <label className={labelClass}>Date to
        <input name="to" type="date" value={query.to ?? ""} className={controlClass} onChange={(e) => navigate("to", e.target.value)} />
      </label>
      {hasFilters && <Link href={clearHref} className="whitespace-nowrap px-3 py-2 text-sm font-medium text-primary underline">Clear filters</Link>}
    </>} />
  </div>;
}
