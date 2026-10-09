import { AlertCircle, CircleCheck, CircleMinus } from "lucide-react";
import type { AdminLocation } from "@/lib/admin/locations";

export const configurationAreas = [
  { label: "Details", requirement: "valid location details", missing: "Location details require attention", target: "details" },
  { label: "Opening hours", requirement: "opening hours", missing: "Opening hours not configured", target: "opening-hours" },
  { label: "Courts", requirement: "an active court", missing: "No active courts", target: "courts" },
  { label: "Pricing", requirement: "pricing for every active court", missing: "Pricing incomplete for active courts", target: "pricing" },
] as const;

export function ConfigurationIndicator({ area, missing }: { area: typeof configurationAreas[number]; missing: string[] }) {
  const needsCourts = area.target === "pricing" && missing.includes("an active court");
  const incomplete = missing.includes(area.requirement) || needsCourts;
  const attention = incomplete && (area.target === "details" || (area.target === "pricing" && !needsCourts));
  const Icon = attention ? AlertCircle : incomplete ? CircleMinus : CircleCheck;
  const description = needsCourts ? "Add active courts before configuring pricing" : incomplete ? area.missing : `${area.label} configured`;
  return <span title={description} className={`inline-flex items-center gap-2 ${attention ? "text-amber-700" : incomplete ? "text-muted-foreground" : "text-success"}`}>
    <Icon size={16} aria-hidden="true" /><span className="sr-only">{description}</span>
  </span>;
}

export function publicationState(location: Pick<AdminLocation, "is_active" | "is_public" | "archived_at">, missing: string[]) {
  if (!location.is_active || location.archived_at) return "Unavailable";
  if (missing.length) return "Setup incomplete";
  return location.is_public ? "Published" : "Ready to publish";
}

export function LocationStatus({ location }: { location: AdminLocation }) {
  const label = location.archived_at ? "Archived" : location.is_active ? "Active" : "Inactive";
  return <span className="inline-flex items-center gap-2 whitespace-nowrap">
    <span aria-hidden="true" className={`size-2 rounded-full ${location.archived_at ? "bg-muted-foreground" : location.is_active ? "bg-success" : "bg-danger"}`} />{label}
  </span>;
}
