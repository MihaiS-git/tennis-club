"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/button";

// `pending` blocks relative steps until the requested day has rendered, so a
// repeated Next/Previous day cannot be computed from the previous `date` prop.
// Steps use aria-disabled while pending to keep keyboard focus on the button.
export function CalendarDateNavigation({ id, date, today, onChange, allowPast = false, pending = false }: {
  id: string; date: string | null; today: string; onChange: (date: string) => void; allowPast?: boolean; pending?: boolean;
}) {
  // Covers repeated activation before React has rendered the pending state.
  const stepping = useRef(false);
  useEffect(() => { if (!pending) stepping.current = false; });
  function stepDate(offset: number) {
    if (!date || pending || stepping.current) return;
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const target = day.toISOString().slice(0, 10);
    if (allowPast || target >= today) {
      stepping.current = true;
      onChange(target);
    }
  }
  return <div className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground">
    <label htmlFor={id}>Date</label>
    <span className="flex items-center gap-1.5">
      <Button type="button" variant="secondary" size="iconLarge" className="max-sm:size-11" aria-label="Previous day" disabled={!date || (!allowPast && date <= today)} aria-disabled={pending || undefined}
        onClick={() => stepDate(-1)}><ChevronLeft aria-hidden className="size-5" /></Button>
      <input id={id} type="date" min={allowPast ? undefined : today} value={date ?? ""} onChange={(event) => onChange(event.target.value)}
        className="min-h-11 min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-3 text-base font-normal text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-10 sm:flex-none sm:text-sm" />
      <Button type="button" variant="secondary" size="iconLarge" className="max-sm:size-11" aria-label="Next day" disabled={!date} aria-disabled={pending || undefined}
        onClick={() => stepDate(1)}><ChevronRight aria-hidden className="size-5" /></Button>
    </span>
  </div>;
}
