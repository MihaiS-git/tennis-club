"use client";

import { useRouter } from "next/navigation";
import { CalendarDateNavigation } from "@/components/calendar-date-navigation";
import { LocationSelect } from "@/components/location-select";

export function CalendarControls({ locations, locationId, date, today }: {
  locations: readonly { id: string; name: string }[]; locationId: string; date: string | null; today: string;
}) {
  const router = useRouter();
  const navigate = (location: string, selectedDate?: string) => {
    const params = new URLSearchParams();
    params.set("location", location);
    if (selectedDate) params.set("date", selectedDate);
    router.push(`/book${params.size ? `?${params}` : ""}`);
  };
  return <div className="flex flex-wrap gap-3">
    <LocationSelect id="book-location" locations={locations} selectedId={locationId} onChange={(id) => navigate(id)} />
    <CalendarDateNavigation id="book-date" date={date} today={today} onChange={(selectedDate) => navigate(locationId, selectedDate)} />
  </div>;
}
