"use client";

import { useTransition } from "react";
import { Button } from "@/components/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDateNavigation } from "@/components/calendar-date-navigation";
import { LocationSelect } from "@/components/location-select";

export const clearCoachingFiltersEvent = "tennis-club:clear-coaching-filters";

function relativeDay(date: string, today: string) {
  if (date === today) return "Today";
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return date === tomorrow.toISOString().slice(0, 10) ? "Tomorrow" : null;
}

export function CalendarControls({ locations, locationId, date, today, timezone, coaching }: {
  locations: readonly { id: string; name: string }[]; locationId?: string; date: string | null; today: string; timezone?: string;
  coaching?: { program?: string; coach?: string; duration?: string };
}) {
  const router = useRouter();
  const [resetPending, startReset] = useTransition();
  const clearFilters = () => {
    // The mounted timetable can veto a reset while its confirmation/payment
    // dialog is open. Native modal inertness also blocks background interaction.
    if (!window.dispatchEvent(new Event(clearCoachingFiltersEvent, { cancelable: true }))) return;
    const href = "/book?mode=coaching";
    startReset(() => {
      // Let the server resolve the same defaults as a fresh Coaching visit.
      if (`${window.location.pathname}${window.location.search}` === href) router.refresh();
      else router.push(href);
    });
  };
  const navigate = (location: string, selectedDate?: string) => {
    const params = new URLSearchParams();
    params.set("location", location);
    if (coaching) {
      params.set("mode", "coaching");
      // A date change keeps lesson choices; a location change resolves fresh defaults.
      if (selectedDate) for (const [key, value] of Object.entries(coaching)) if (value) params.set(key, value);
    }
    if (selectedDate) params.set("date", selectedDate);
    router.push(`/book${params.size ? `?${params}` : ""}`);
  };
  const dateLabel = date && new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  const relative = date && relativeDay(date, today);
  return <><nav aria-label="Booking mode" className="mt-5 flex gap-2">
    <Link href="/book" aria-current={!coaching ? "page" : undefined} className="rounded-control border border-border-strong px-4 py-2 text-sm font-semibold text-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Court booking</Link>
    <Link href="/book?mode=coaching" aria-current={coaching ? "page" : undefined} className="rounded-control border border-border-strong px-4 py-2 text-sm font-semibold text-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Coaching</Link>
  </nav><div className="mt-5 flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-5 lg:flex-row lg:items-end lg:justify-between">
    <div className="min-w-0">
      {relative && <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{relative}</p>}
      <h2 className="font-heading text-xl font-semibold leading-tight text-primary sm:text-2xl">{dateLabel || (locationId ? "Choose a date" : "Choose a location")}</h2>
      {timezone && <p className="mt-1 text-xs text-muted-foreground">Times shown in {timezone}.</p>}
    </div>
    <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
      <LocationSelect id="book-location" locations={locations} selectedId={locationId ?? ""} onChange={(id) => navigate(id)} />
      {locationId && <CalendarDateNavigation id="book-date" date={date} today={today} onChange={(selectedDate) => navigate(locationId, selectedDate)} />}
      {coaching && <Button type="button" variant="secondary" disabled={resetPending} aria-busy={resetPending}
        onClick={clearFilters} className="min-h-11 self-end sm:min-h-10">Clear filters</Button>}
    </div>
  </div></>;
}
