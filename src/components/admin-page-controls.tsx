import type { ReactNode } from "react";

export function AdminPageHeader({ title, description }: { title: string; description: string }) {
  return <header className="mb-8 md:mb-10">
    <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">{title}</h1>
    <p className="mt-3 max-w-2xl text-base text-muted-foreground">{description}</p>
  </header>;
}

export function AdminToolbar({ primary, action, filters, metadata }: {
  primary: ReactNode;
  action?: ReactNode;
  filters?: ReactNode;
  metadata?: ReactNode;
}) {
  return <div className="mb-6 flex flex-wrap items-end gap-3 text-sm">
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
