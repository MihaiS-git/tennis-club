export function LocationSelect({ id, locations, selectedId, onChange, disabled = false }: {
  id: string;
  locations: readonly { id: string; name: string }[];
  selectedId: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return <div className="flex min-w-44 flex-col gap-1">
    <label htmlFor={id} className="text-xs font-semibold text-primary">Location</label>
    <select id={id} value={selectedId} disabled={disabled || locations.length === 0}
      onChange={(event) => onChange(event.target.value)}
      className="min-h-9 rounded-control border border-border-strong bg-surface px-3 text-sm font-normal text-foreground">
      {locations.length === 0 && <option value="">No locations available</option>}
      {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  </div>;
}
