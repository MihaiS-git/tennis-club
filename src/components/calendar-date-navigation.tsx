"use client";

export function CalendarDateNavigation({ id, date, today, onChange, allowPast = false }: {
  id: string; date: string | null; today: string; onChange: (date: string) => void; allowPast?: boolean;
}) {
  function stepDate(offset: number) {
    if (!date) return;
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const target = day.toISOString().slice(0, 10);
    if (allowPast || target >= today) onChange(target);
  }
  return <div className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-primary">
    <label htmlFor={id}>Date</label>
    <span className="flex items-center gap-2">
      <button type="button" disabled={!date || (!allowPast && date <= today)} onClick={() => stepDate(-1)}
        className="min-h-9 rounded-control border border-border-strong px-3 text-sm disabled:opacity-50">Prev</button>
      <input id={id} type="date" min={allowPast ? undefined : today} value={date ?? ""} onChange={(event) => onChange(event.target.value)}
        className="min-h-9 rounded-control border border-border-strong bg-surface px-2 text-sm font-normal text-foreground" />
      <button type="button" disabled={!date} onClick={() => stepDate(1)}
        className="min-h-9 rounded-control border border-border-strong px-3 text-sm disabled:opacity-50">Next</button>
    </span>
  </div>;
}
