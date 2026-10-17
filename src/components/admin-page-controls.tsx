import type { ReactNode } from "react";

// One compact header for every Admin page, matching the My activity and Profile areas.
export function AdminPageHeader({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return <header className="mb-6">
    <h1 className="break-words font-heading text-3xl font-semibold text-primary">{title}</h1>
    <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
    {children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
  </header>;
}

export function AdminToolbar({ primary, action, filters, metadata }: {
  primary: ReactNode;
  action?: ReactNode;
  filters?: ReactNode;
  metadata?: ReactNode;
}) {
  return <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
    {primary}
    {filters}
    {metadata && <div className="min-w-60 flex-1 pb-2 text-sm text-muted-foreground">{metadata}</div>}
    {action && <div className="ml-auto">{action}</div>}
  </div>;
}

export function AdminLocationSelect({ locations, selectedId, onChange }: {
  locations: { id: string; name: string; is_active: boolean }[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  return <label className="flex w-full flex-col gap-1.5 text-sm font-medium text-primary sm:w-64">
    Location
    <select name="location" value={selectedId}
      className="min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      onChange={(event) => onChange(event.target.value)}>
      {!selectedId && <option value="">Select a location</option>}
      {locations.map((location) => <option key={location.id} value={location.id}>
        {location.name}{location.is_active ? "" : " (inactive)"}
      </option>)}
    </select>
  </label>;
}
