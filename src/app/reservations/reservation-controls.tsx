"use client";

import { useRouter } from "next/navigation";
import { CalendarDateNavigation } from "@/components/calendar-date-navigation";
import { LocationSelect } from "@/components/location-select";

export function ReservationControls({ locations, locationId, date, today }: {
  locations: readonly { id: string; name: string }[]; locationId: string; date: string | null; today: string;
}) {
  const router = useRouter();
  const navigate = (location: string, selectedDate?: string) => {
    const params = new URLSearchParams();
    params.set("location", location);
    if (selectedDate) params.set("date", selectedDate);
    router.push(`/reservations${params.size ? `?${params}` : ""}`);
  };
  return <div className="mt-3 flex flex-wrap gap-3">
    <LocationSelect id="reservation-location" locations={locations} selectedId={locationId} onChange={(id) => navigate(id)} />
    <CalendarDateNavigation id="reservation-date" date={date} today={today} allowPast onChange={(selectedDate) => navigate(locationId, selectedDate)} />
  </div>;
}
