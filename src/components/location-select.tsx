export function LocationSelect({ id, locations, selectedId, onChange, disabled = false }: {
  id: string;
  locations: readonly { id: string; name: string }[];
  selectedId: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return <div className="flex min-w-44 flex-col gap-1">
    <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">Location</label>
    <select id={id} value={selectedId} disabled={disabled || locations.length === 0}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-11 rounded-control border border-border-strong bg-surface px-3 text-base font-normal text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-10 sm:text-sm">
      {locations.length === 0 ? <option value="">No locations available</option>
        : !locations.some((item) => item.id === selectedId) && <option value="" disabled>Choose a location</option>}
      {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  </div>;
}
