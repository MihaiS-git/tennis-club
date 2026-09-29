"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import { minuteToTime, weeklySchedule, type OpeningInterval, type OpeningHoursMutationResult } from "@/lib/admin/opening-hours-validation";
import { saveOpeningHoursAction, removeOpeningHoursAction } from "./opening-hours-actions";

const buttonClass = "rounded-control border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";

export function OpeningHours({ locationId, intervals }: { locationId: string; intervals: OpeningInterval[] }) {
  const prefix = useId();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ weekday: number; interval?: OpeningInterval } | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const schedule = weeklySchedule(locationId, intervals);

  async function mutate(operation: () => Promise<OpeningHoursMutationResult>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setError(""); setFieldErrors({});
    try {
      const result = await operation();
      if (result.ok) {
        setEditing(null);
        toast.success("Opening hours updated.");
      } else if (result.reason === "invalid-input") {
        setError("Check the opening hours."); setFieldErrors(result.fieldErrors);
      } else {
        setError(result.reason === "overlap" ? "This interval overlaps existing opening hours for this day." : "This location or interval no longer exists.");
      }
    } catch {
      setError("Unable to change opening hours. Please try again.");
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  return <section aria-labelledby={`${prefix}-heading`} className="text-sm">
    <h2 id={`${prefix}-heading`} className="mb-2 font-semibold text-foreground">Opening hours</h2>
    {!schedule.some((day) => day.intervals.length > 0) && <p className="mb-3 text-xs text-muted-foreground">Opening hours not configured. Add intervals to open a day.</p>}
    {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
    <ul className="divide-y divide-border">
      {schedule.map((day) => <li key={day.weekday} className="py-2">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <span className="w-24 shrink-0 font-medium">{day.label}</span>
          <div className="min-w-0 flex-1 space-y-2">
            {day.intervals.length === 0 ? <span className="text-muted-foreground">Closed</span> : day.intervals.map((interval) => <div key={interval.id} className="flex flex-wrap items-center gap-2">
              <span className="mr-auto tabular-nums">{minuteToTime(interval.opens_at_minute)}–{minuteToTime(interval.closes_at_minute)}</span>
              <button type="button" className={buttonClass} disabled={pending} aria-label={`Edit ${day.label} ${minuteToTime(interval.opens_at_minute)} interval`}
                onClick={() => { setEditing({ weekday: day.weekday, interval }); setError(""); setFieldErrors({}); }}>Edit</button>
              <button type="button" className={buttonClass} disabled={pending} aria-label={`Remove ${day.label} ${minuteToTime(interval.opens_at_minute)} interval`}
                onClick={() => void mutate(() => removeOpeningHoursAction({ id: interval.id, location_id: locationId }))}>Remove</button>
            </div>)}
          </div>
          <button type="button" className={buttonClass} disabled={pending} aria-label={`Add ${day.label} interval`}
            onClick={() => { setEditing({ weekday: day.weekday }); setError(""); setFieldErrors({}); }}>Add interval</button>
        </div>
        {editing?.weekday === day.weekday && <form key={editing.interval?.id ?? `new-${day.weekday}`} className="mt-3 rounded-control bg-surface-muted p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void mutate(() => saveOpeningHoursAction({
              ...(editing.interval ? { id: editing.interval.id } : {}), location_id: locationId,
              weekday: day.weekday, opens_at: data.get("opens_at"), closes_at: data.get("closes_at"),
            }));
          }}>
          <fieldset disabled={pending} className="flex flex-wrap items-end gap-3">
            {(["opens_at", "closes_at"] as const).map((field) => <div key={field} className="w-32">
              <label htmlFor={`${prefix}-${field}`} className="mb-1 block text-xs font-medium">{field === "opens_at" ? "Opening time" : "Closing time"}</label>
              <Input id={`${prefix}-${field}`} name={field} type="text" inputMode="text" required maxLength={5}
                pattern={field === "opens_at" ? "([01][0-9]|2[0-3]):[0-5][0-9]" : "([01][0-9]|2[0-3]):[0-5][0-9]|24:00"}
                placeholder="HH:mm" defaultValue={editing.interval ? minuteToTime(editing.interval[field === "opens_at" ? "opens_at_minute" : "closes_at_minute"]) : ""}
                aria-invalid={Boolean(fieldErrors[field])} aria-describedby={fieldErrors[field] ? `${prefix}-${field}-error` : undefined} />
              {fieldErrors[field] && <p id={`${prefix}-${field}-error`} className="mt-1 text-xs text-danger">{fieldErrors[field]}</p>}
            </div>)}
            <button type="submit" className={buttonClass} aria-busy={pending}>{pending ? "Saving…" : "Save interval"}</button>
            <button type="button" className={buttonClass} onClick={() => { setEditing(null); setError(""); setFieldErrors({}); }}>Cancel</button>
          </fieldset>
          <p className="mt-2 text-xs text-muted-foreground">Use HH:mm. Closing time may be 24:00. Times are local to this location.</p>
        </form>}
      </li>)}
    </ul>
  </section>;
}
