"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

const stepButton = "inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-primary transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface sm:size-10";

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
  return <div className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
    <label htmlFor={id}>Date</label>
    <span className="flex items-center gap-1.5">
      <button type="button" aria-label="Previous day" disabled={!date || (!allowPast && date <= today)} onClick={() => stepDate(-1)}
        className={stepButton}><ChevronLeft aria-hidden className="size-5" /></button>
      <input id={id} type="date" min={allowPast ? undefined : today} value={date ?? ""} onChange={(event) => onChange(event.target.value)}
        className="min-h-11 min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-3 text-base font-normal text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-10 sm:flex-none sm:text-sm" />
      <button type="button" aria-label="Next day" disabled={!date} onClick={() => stepDate(1)}
        className={stepButton}><ChevronRight aria-hidden className="size-5" /></button>
    </span>
  </div>;
}
