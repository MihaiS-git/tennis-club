"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/input";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import {
  editorIntervalSchema, groupedWeeklySchedule, minuteToTime, weekdayGroupLabel, weekdays,
  type OpeningInterval, type OpeningHoursMutationResult,
} from "@/lib/admin/opening-hours-validation";
import { mutateOpeningHoursAction } from "./opening-hours-actions";

type DraftInterval = { opens_at: string; closes_at: string };
type Draft = { weekdays: number[]; replacements: { weekday: number; id: string }[]; intervals: DraftInterval[] };
type Removal = { weekdays: number[]; ids: string[]; label: string };
const emptyDraft = (): Draft => ({ weekdays: [], replacements: [], intervals: [{ opens_at: "", closes_at: "" }] });
const suggestions = Array.from({ length: 48 }, (_, index) => minuteToTime(index * 30));
const draftSnapshot = (draft: Draft) => JSON.stringify({
  weekdays: [...draft.weekdays].sort((a, b) => a - b),
  intervals: draft.intervals.map((interval) => ({ opens_at: interval.opens_at.trim(), closes_at: interval.closes_at.trim() })),
});

export function OpeningHours({ locationId, intervals, onUpdated }: {
  locationId: string; intervals: OpeningInterval[]; onUpdated: (intervals: OpeningInterval[]) => void;
}) {
  const prefix = useId();
  const router = useRouter();
  const pendingRef = useRef(false);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editBaseline, setEditBaseline] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const groups = groupedWeeklySchedule(locationId, intervals);
  const hasHours = groups.some((group) => group.intervals.length > 0);
  const canAddInterval = draft.intervals.length === 1 && editorIntervalSchema.safeParse(draft.intervals[0]).success;

  function startEdit(days: number[], ids: string[], interval: DraftInterval) {
    const next = { weekdays: [...days], replacements: days.map((weekday, index) => ({ weekday, id: ids[index] })), intervals: [interval] };
    setDraft(next);
    setEditBaseline(draftSnapshot(next));
    setError(""); setFieldErrors({});
  }

  async function mutate(next: Draft) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setError(""); setFieldErrors({});
    try {
      const result: OpeningHoursMutationResult = await mutateOpeningHoursAction({
        location_id: locationId, weekdays: next.weekdays,
        replace_ids: next.replacements.filter((item) => next.weekdays.includes(item.weekday)).map((item) => item.id),
        intervals: next.intervals,
      });
      if (result.ok) {
        onUpdated(result.intervals);
        setDraft(emptyDraft());
        setEditBaseline(null);
        setRemoving(null);
        toast.success("Opening hours updated.");
        router.refresh();
      } else if (result.reason === "invalid-input") {
        setError(result.fieldErrors.weekdays || result.fieldErrors.form || result.fieldErrors.intervals || "Check the selected days and times.");
        setFieldErrors(result.fieldErrors);
      } else if (result.reason === "overlap") {
        const days = result.weekdays.map((day) => weekdays[day]).join(", ");
        setError(`${days || "Selected days"} ${result.weekdays.length === 1 ? "conflicts" : "conflict"} with existing opening hours. No changes were saved.`);
      } else if (result.reason === "pricing-conflict") {
        setError(result.message);
      } else if (result.reason === "archived") {
        setError("Restore this location before changing its opening hours.");
      } else {
        setError("This location or interval no longer exists. Refresh and try again.");
      }
    } catch {
      setError("Unable to change opening hours. Please try again.");
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }

  function setDays(days: number[]) { setDraft((current) => ({ ...current, weekdays: days })); }
  function setTime(index: number, field: keyof DraftInterval, value: string) {
    setDraft((current) => ({ ...current, intervals: current.intervals.map((interval, position) =>
      position === index ? { ...interval, [field]: value } : interval) }));
  }

  return <section aria-labelledby={`${prefix}-heading`} className="text-sm">
    <h2 id={`${prefix}-heading`} className="mb-2 font-semibold text-foreground">Weekly schedule</h2>
    {hasHours ? <ul aria-label="Current weekly schedule" className="divide-y divide-border border-y border-border">
      {groups.map((group) => <li key={group.weekdays.join("-")} className="flex items-start gap-3 py-2">
        <span className="w-24 shrink-0 pt-1 font-medium sm:w-28">{weekdayGroupLabel(group.weekdays)}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {group.intervals.length === 0 ? <span className="py-1 text-muted-foreground">Closed</span> : group.intervals.map((interval) => {
            const label = `${minuteToTime(interval.opens_at_minute)}–${minuteToTime(interval.closes_at_minute)}`;
            return <div key={interval.ids.join("-")} className="flex items-center gap-1">
              <Button type="button" variant="subtle" size="small" disabled={pending} className="tabular-nums"
                aria-label={`Edit ${weekdayGroupLabel(group.weekdays)} ${label}`}
                onClick={() => startEdit(group.weekdays, interval.ids, { opens_at: minuteToTime(interval.opens_at_minute), closes_at: minuteToTime(interval.closes_at_minute) })}>{label}</Button>
              <Button type="button" variant="destructive" size="icon" disabled={pending}
                aria-label={`Remove ${weekdayGroupLabel(group.weekdays)} ${label}`}
                onClick={(event) => { removeTriggerRef.current = event.currentTarget; setError(""); setRemoving({ weekdays: group.weekdays, ids: interval.ids, label }); }}><Trash2 size={14} aria-hidden="true" /></Button>
            </div>;
          })}
        </div>
      </li>)}
    </ul> : <p className="border-y border-border py-3 text-muted-foreground">Not configured</p>}

    <ConfirmationDialog open={removing !== null} title={removing ? `Remove ${weekdayGroupLabel(removing.weekdays)} opening hours?` : "Remove opening hours?"}
      message={removing ? `${removing.label} will be removed from ${weekdayGroupLabel(removing.weekdays)} opening hours.` : ""}
      confirmLabel="Remove hours" pending={pending} error={error} returnFocusRef={removeTriggerRef}
      onClose={() => { if (!pendingRef.current) { setRemoving(null); setError(""); } }}
      onConfirm={() => { if (removing) void mutate({ weekdays: removing.weekdays,
        replacements: removing.weekdays.map((weekday, index) => ({ weekday, id: removing.ids[index] })), intervals: [] }); }} />
    <form className="mt-4" onSubmit={(event) => { event.preventDefault(); void mutate(draft); }}>
      <fieldset disabled={pending}>
        <legend className="mb-2 font-semibold">Days</legend>
        <div className="mb-2 flex flex-wrap gap-2">
          {([
            ["Weekdays", [0, 1, 2, 3, 4]], ["Weekend", [5, 6]], ["All days", [0, 1, 2, 3, 4, 5, 6]],
          ] as const).map(([label, days]) => <Button key={label} type="button" variant="secondary" size="small"
            onClick={() => setDays([...days])}>{label}</Button>)}
        </div>
        <div className="mb-4 flex flex-wrap gap-x-3 gap-y-2">
          {weekdays.map((label, day) => <label key={label} className="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={draft.weekdays.includes(day)} onChange={(event) => setDays(event.target.checked
              ? [...draft.weekdays, day].sort((a, b) => a - b) : draft.weekdays.filter((selected) => selected !== day))} />
            {label.slice(0, 3)}
          </label>)}
        </div>
        <div className="space-y-2">
          {draft.intervals.map((interval, index) => <div key={index} className="flex flex-wrap items-end gap-2">
            {(["opens_at", "closes_at"] as const).map((field) => <div key={field} className="w-32">
              <label htmlFor={`${prefix}-${field}-${index}`} className="mb-1 block text-xs font-medium">{field === "opens_at" ? "Opening time" : "Closing time"}</label>
              <Input id={`${prefix}-${field}-${index}`} type="text" inputMode="text" maxLength={5} placeholder="HH:mm"
                list={`${prefix}-${field}-suggestions`} value={interval[field]}
                onChange={(event) => setTime(index, field, event.target.value)}
                aria-invalid={Boolean(fieldErrors[field])} aria-describedby={`${prefix}-${field}-error`} />
            </div>)}
            {draft.intervals.length > 1 && <Button type="button" variant="destructive" size="icon"
              aria-label={`Remove draft interval ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, intervals: current.intervals.filter((_, position) => position !== index) }))}>
              <Trash2 size={15} aria-hidden="true" /></Button>}
          </div>)}
        </div>
        <datalist id={`${prefix}-opens_at-suggestions`}>{suggestions.map((time) => <option key={time} value={time} />)}</datalist>
        <datalist id={`${prefix}-closes_at-suggestions`}>{[...suggestions, "24:00"].map((time) => <option key={time} value={time} />)}</datalist>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {draft.intervals.length === 1 && <Button type="button" variant="subtle" size="small" disabled={!canAddInterval} className="gap-1"
            onClick={() => setDraft((current) => current.intervals.length === 1 && editorIntervalSchema.safeParse(current.intervals[0]).success
              ? { ...current, intervals: [...current.intervals, { opens_at: "", closes_at: "" }] } : current)}>
            <Plus size={14} aria-hidden="true" /> Add interval
          </Button>}
          {draft.replacements.length > 0 && <Button type="button" variant="secondary" size="small" onClick={() => { setDraft(emptyDraft()); setEditBaseline(null); setError(""); setFieldErrors({}); }}>Cancel edit</Button>}
        </div>
        <p id={`${prefix}-opens_at-error`} className="min-h-4 text-xs text-danger">{fieldErrors.opens_at ?? ""}</p>
        <p id={`${prefix}-closes_at-error`} className="min-h-4 text-xs text-danger">{fieldErrors.closes_at ?? ""}</p>
        <p role={error && !removing ? "alert" : undefined} className="min-h-10 py-2 text-sm text-danger">{removing ? "" : error}</p>
        <Button type="submit" fullWidth={false} disabled={pending || (editBaseline !== null ? draftSnapshot(draft) === editBaseline : draft.weekdays.length === 0 || !draft.intervals.some((interval) => editorIntervalSchema.safeParse(interval).success))} aria-busy={pending}>
          {pending ? "Saving…" : draft.replacements.length ? "Apply changes to selected days" : "Apply to selected days"}
        </Button>
      </fieldset>
      <p className="mt-2 text-xs text-muted-foreground">Times are local to this location. Closing time may be 24:00.</p>
    </form>
  </section>;
}
