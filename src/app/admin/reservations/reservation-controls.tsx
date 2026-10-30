"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useStaffCalendar } from "@/components/staff-calendar-context";
import { LoadingStatus } from "@/components/loading-status";
import { CalendarDateNavigation } from "@/components/calendar-date-navigation";
import { LocationSelect } from "@/components/location-select";

// `href` is the hosting calendar route, including any fixed query such as its view tab.
export function ReservationControls({ locations, locationId, date, today, href = "/admin/reservations" }: {
  locations: readonly { id: string; name: string }[]; locationId: string; date: string | null; today: string; href?: string;
}) {
  const router = useRouter();
  const calendar = useStaffCalendar();
  const rescheduling = calendar?.active;
  const [pending, startNavigation] = useTransition();
  // Inputs show the requested choice while the current calendar stays rendered.
  const [shownLocation, showLocation] = useOptimistic(locationId);
  const [shownDate, showDate] = useOptimistic(date);
  const navigate = (location: string, selectedDate?: string) => {
    if (rescheduling) { if (calendar.target) calendar.navigate(location, selectedDate ?? calendar.target.date); return; }
    const [path, query] = href.split("?");
    const params = new URLSearchParams(query);
    params.set("location", location);
    if (selectedDate) params.set("date", selectedDate);
    startNavigation(() => {
      showLocation(location);
      if (selectedDate) showDate(selectedDate);
      router.push(`${path}${params.size ? `?${params}` : ""}`);
    });
  };
  return <div aria-busy={pending} className="mt-3 flex flex-wrap gap-3">
    <LocationSelect id="reservation-location" locations={locations} selectedId={rescheduling ? calendar.target?.locationId ?? shownLocation : shownLocation} disabled={!!rescheduling && calendar.loading} onChange={(id) => navigate(id)} />
    <CalendarDateNavigation id="reservation-date" date={rescheduling ? calendar.target?.date ?? shownDate : shownDate} today={today} allowPast={!rescheduling} pending={pending || rescheduling && calendar.loading}
      onChange={(selectedDate) => navigate(rescheduling ? calendar.target?.locationId ?? shownLocation : shownLocation, selectedDate)} />
    <LoadingStatus compact pending={pending} label="Updating calendar…" />
  </div>;
}
