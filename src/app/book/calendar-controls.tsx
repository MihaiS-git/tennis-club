"use client";

import { useRouter } from "next/navigation";
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
    <label className="flex min-w-44 flex-col gap-1 text-xs font-semibold text-primary">Date
      <input type="date" min={today} value={date ?? ""} onChange={(event) => navigate(locationId, event.target.value)}
        className="min-h-9 rounded-control border border-border-strong bg-surface px-3 text-sm font-normal text-foreground" />
    </label>
  </div>;
}
