"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LocationSelect } from "@/components/location-select";
import { LoadingStatus } from "@/components/loading-status";

// Re-renders the homepage on the server for the selected location; the server
// remains authoritative and falls back to the first public location.
export function HomeLocationSelect({ locations, selectedId }: {
  locations: readonly { id: string; name: string }[]; selectedId: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(selectedId);
  const [pending, startTransition] = useTransition();
  return <div className="flex flex-col items-start gap-1 sm:items-end">
    <LocationSelect id="home-location" locations={locations} selectedId={value} onChange={(id) => {
      setValue(id);
      startTransition(() => router.push(`/?${new URLSearchParams({ location: id })}`, { scroll: false }));
    }} />
    <LoadingStatus compact pending={pending} label="Updating availability…" />
  </div>;
}
