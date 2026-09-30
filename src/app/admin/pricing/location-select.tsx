"use client";

import { useRouter } from "next/navigation";

export function PricingLocationSelect({ locations, selectedId }: {
  locations: { id: string; name: string; is_active: boolean }[]; selectedId?: string;
}) {
  const router = useRouter();
  return <div className="mb-6"><label htmlFor="pricing-location" className="mb-1 block text-sm font-medium">Location</label>
    <select id="pricing-location" name="location" value={selectedId ?? ""}
      onChange={(event) => router.push(`/admin/pricing?location=${encodeURIComponent(event.target.value)}`)}
      className="min-h-11 rounded-control border border-border-strong bg-surface px-3">
      {!selectedId && <option value="">Select a location</option>}
      {locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.is_active ? "" : " (inactive)"}</option>)}
    </select>
  </div>;
}
