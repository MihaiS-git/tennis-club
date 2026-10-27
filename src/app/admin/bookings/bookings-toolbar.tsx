"use client";

import Link from "next/link";

import { FilterPendingIndicator } from "@/components/navigation-pending";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { AdminBookingFilterCoach, AdminBookingFilterLocation } from "@/lib/bookings/admin-details";
import { adminListStatusOptions, adminListTypeLabels, coachListStatusOptions, coachListTypeLabels, parseAdminBookingQuery,
  parseCoachBookingQuery } from "@/lib/bookings/admin-query";
import type { ListScope } from "./booking-row";
import { FilterClearSlot } from "@/components/filter-clear-slot";

// Coaches choose only between their own lessons and their own staff reservations.
const scoped = {
  admin: { parse: parseAdminBookingQuery, types: adminListTypeLabels, statuses: adminListStatusOptions, placeholder: "ID, customer, staff or reason" },
  coach: { parse: parseCoachBookingQuery, types: coachListTypeLabels, statuses: coachListStatusOptions, placeholder: "ID, customer or reason" },
};

export function BookingsToolbar({ locations, coaches = [], scope = "admin" }: {
  locations: AdminBookingFilterLocation[]; coaches?: AdminBookingFilterCoach[]; scope?: ListScope;
}) {
  const { parse, types, statuses, placeholder } = scoped[scope];
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const queryString = searchParams.toString();
  const filters = parse(Object.fromEntries(["q", "type", "coach", "status", "location", "court", "from", "to"].map((key) => {
    const values = searchParams.getAll(key); return [key, values.length === 1 ? values[0] : undefined];
  })));
  const location = locations.find((item) => item.id === filters.location);
  const [draft, setDraft] = useState({ queryString, text: filters.q });
  if (draft.queryString !== queryString) setDraft({ queryString, text: filters.q });
  const text = draft.queryString === queryString ? draft.text : filters.q;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentQuery = useRef(queryString);
  function cancelSearch() { clearTimeout(timer.current); }
  useEffect(() => { currentQuery.current = queryString; return () => clearTimeout(timer.current); }, [queryString]);
  // Every filter change returns to page 1; changing location also clears its court.
  function navigate(changes: Record<string, string>) {
    cancelSearch();
    const params = new URLSearchParams(currentQuery.current);
    for (const [key, value] of Object.entries(changes)) if (value && value !== "all") params.set(key, value); else params.delete(key);
    if (changes.type && changes.type !== "coaching") params.delete("coach");
    // A status outside the new Type's lifecycle would match nothing, so it is cleared.
    const status = params.get("status");
    if (changes.type && status && !statuses(parse({ type: changes.type }).type).some(([value]) => value === status)) params.delete("status");
    params.delete("page"); currentQuery.current = params.toString();
    startTransition(() => router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false }));
  }
  const control = "min-h-10 min-w-0 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-foreground disabled:bg-surface-muted disabled:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const field = "flex min-w-0 flex-col gap-1.5 font-medium text-primary";
  const hasFilters = Boolean(filters.q || filters.type !== "all" || filters.status !== "all" || filters.location || filters.from || filters.to);
  return <div className="relative mb-4 space-y-3 text-sm">
    {/* Admin Coach is always rendered (disabled outside Coaching) so choosing a Type
        never adds a grid column and moves the filters after it. */}
    <div className={`grid min-w-0 grid-cols-2 items-end gap-3 ${scope === "admin"
      ? "lg:grid-cols-[minmax(0,1.8fr)_repeat(5,minmax(0,1fr))]"
      : "lg:grid-cols-[minmax(0,1.8fr)_repeat(4,minmax(0,1fr))]"}`}>
      <label className={`${field} col-span-2 lg:col-span-1`}>
        Search<input type="search" value={text} maxLength={200} placeholder={placeholder} className={control}
          onChange={(event) => {
            const next = event.target.value; setDraft({ queryString, text: next }); cancelSearch();
            const scheduled = currentQuery.current;
            timer.current = setTimeout(() => { if (scheduled === currentQuery.current) navigate({ q: next.trim() }); }, 350);
          }} />
      </label>
      <label className={field}>Type<select value={filters.type} className={control} onChange={(event) => navigate({ type: event.target.value })}>
        <option value="all">All</option>{Object.entries(types).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      {scope === "admin" && <label className={field}>Coach<select disabled={filters.type !== "coaching"}
        title={filters.type === "coaching" ? undefined : "Select the Coaching type first"}
        value={filters.type === "coaching" && coaches.some((coach) => coach.id === filters.coach) ? filters.coach : ""} className={control}
        onChange={(event) => navigate({ coach: event.target.value })}>
        {filters.type === "coaching" ? <>
          <option value="">All</option>{coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
        </> : <option value="">Select Coaching type</option>}
      </select></label>}
      <label className={field}>Status<select value={filters.status} className={control} onChange={(event) => navigate({ status: event.target.value })}>
        <option value="all">All</option>{statuses(filters.type).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select></label>
      <label className={field}>Location<select value={location?.id ?? ""} className={control} onChange={(event) => navigate({ location: event.target.value, court: "" })}>
        <option value="">All</option>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}
      </select></label>
      <label className={field}>Court<select value={location?.courts.some((court) => court.id === filters.court) ? filters.court : ""}
        disabled={!location} title={location ? undefined : "Select a location first"} className={control} onChange={(event) => navigate({ court: event.target.value })}>
        <option value="">{location ? "All" : "Select a location"}</option>
        {location?.courts.map((court) => <option key={court.id} value={court.id}>{court.name}</option>)}
      </select></label>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label className={`${field} w-full min-[360px]:w-[calc(50%-0.375rem)] sm:w-40`}>From<input type="date" value={filters.from} max={filters.to || undefined} className={control}
        onChange={(event) => navigate({ from: event.target.value })} /></label>
      <label className={`${field} w-full min-[360px]:w-[calc(50%-0.375rem)] sm:w-40`}>To<input type="date" value={filters.to} min={filters.from || undefined} className={control}
        onChange={(event) => navigate({ to: event.target.value })} /></label>
      <FilterClearSlot active={hasFilters}>
        <Link scroll={false} href={pathname} onNavigate={event => { event.preventDefault(); currentQuery.current = ""; startTransition(() => router.replace(pathname, { scroll: false })); }} onClick={cancelSearch} className="inline-flex min-h-10 items-center whitespace-nowrap rounded-control px-2 font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Clear filters</Link>
      </FilterClearSlot>
    </div>
    <FilterPendingIndicator pending={pending} />
  </div>;
}
