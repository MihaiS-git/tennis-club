"use client";

import { z } from "zod";
import { useId, useRef, useState, type ReactNode } from "react";
import { groupedWeeklySchedule, weekdayGroupLabel } from "@/lib/admin/opening-hours-validation";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DialogFooter, DialogHeader } from "@/components/dialog-layout";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import type { CoachAvailabilityExceptionRow, CoachAvailabilityLocation, CoachWeeklyInterval } from "@/lib/coaching/availability";
import {
  availabilityFailureMessages, availabilityMinuteOptions, availabilityOutsideOpeningHoursMessage, availabilityOverlapMessage, availabilityWeekdays,
  formatAvailabilityMinute, formatAvailabilityRange,
  type AvailabilityChange, type AvailabilityMutationResult, type CoachAvailabilityExceptionKind,
} from "@/lib/coaching/availability-validation";
import { openOnWeekdayThroughout } from "@/lib/coaching/working-hours";

export type AvailabilityChangeAction = (change: AvailabilityChange) => Promise<AvailabilityMutationResult>;

const selectClass = "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20 disabled:cursor-not-allowed disabled:bg-background disabled:text-muted-foreground disabled:opacity-60";
const labelClass = "mb-1.5 block text-sm font-medium";
const hintClass = "mt-1 text-xs text-muted-foreground";
const dialogClass = "fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50";

export function locationLabel(location: CoachAvailabilityLocation | undefined) {
  if (!location) return "Unassigned location";
  return `${location.name}${location.archived ? " (archived)" : location.is_active ? "" : " (inactive)"}`;
}

// Submits one change, maps failures to fields, and refreshes the server data on success.
function useAvailabilitySubmit(action: AvailabilityChangeAction) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function submit(change: AvailabilityChange, success: string, done: () => void) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setFieldErrors({});
    const notification = toast.loading("Saving availability…");
    try {
      const result = await action(change);
      if (result.ok) {
        toast.success(success, { id: notification });
        done();
        router.refresh();
      } else if (result.reason === "invalid-input") {
        toast.dismiss(notification); setFieldErrors(result.fieldErrors);
      } else if (result.reason === "outside-opening-hours") {
        toast.dismiss(notification); setFieldErrors({ form: availabilityOutsideOpeningHoursMessage(result.weekdays) });
      } else if (result.reason === "booking-conflict" || result.reason === "overlap" || result.reason === "out-of-range" || result.reason === "invalid-location") {
        toast.dismiss(notification);
        setFieldErrors(result.reason === "booking-conflict" ? { form: availabilityFailureMessages[result.reason] } : result.reason === "overlap" ? { form: availabilityOverlapMessage(result.weekdays) }
          : { [result.reason === "invalid-location" ? "location_id" : "date"]: availabilityFailureMessages[result.reason] });
      } else {
        toast.error(availabilityFailureMessages[result.reason], { id: notification });
      }
    } catch {
      toast.error("Unable to save availability. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }
  return { pending, pendingRef, fieldErrors, setFieldErrors, submit };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="mt-1 text-sm text-danger">{message}</p> : null;
}

function MinuteSelect({ id, name, label, defaultValue, value, onChange, disabled, error, ends, allowed }: {
  value?: number | null; onChange?: (minute: number | null) => void; disabled?: boolean;
  id: string; name: string; label: string; defaultValue?: number | null; error?: string; ends?: boolean; allowed?: (minute: number) => boolean;
}) {
  return <div>
    <label htmlFor={id} className={labelClass}>{label}</label>
    <select id={id} name={name} required className={selectClass} disabled={disabled}
      {...value !== undefined ? { value: value ?? "" } : { defaultValue: defaultValue ?? "" }}
      onChange={onChange ? (event) => onChange(event.target.value === "" ? null : Number(event.target.value)) : undefined}
      aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      <option value="" disabled>Select</option>
      {value != null && allowed && !allowed(value) && <option value={value} disabled>{formatAvailabilityMinute(value)}</option>}
      {availabilityMinuteOptions.filter((minute) => (ends ? minute > 0 : minute < 1440) && (!allowed || allowed(minute)))
        .map((minute) => <option key={minute} value={minute}>{formatAvailabilityMinute(minute)}</option>)}
    </select>
    <FieldError id={`${id}-error`} message={error} />
  </div>;
}

function minuteValue(data: FormData, field: string) {
  const value = data.get(field);
  return typeof value === "string" && value !== "" ? Number(value) : null;
}

function text(data: FormData, field: string) {
  const value = data.get(field);
  return typeof value === "string" ? value : "";
}

function AvailabilityDialog({ title, open, pending, dialogRef, onClose, children }: {
  title: string; open: boolean; pending: boolean; dialogRef: React.RefObject<HTMLDialogElement | null>; onClose: () => void; children: ReactNode;
}) {
  const titleId = useId();
  return <ModalDialog ref={dialogRef} active={open} aria-labelledby={titleId} onClose={onClose}
    onCancel={(event) => { if (pending) event.preventDefault(); }} className={dialogClass}>
    {open && <div className="p-5 sm:p-6">
      <div className="mb-5"><DialogHeader titleId={titleId} title={title} disabled={pending} onClose={() => dialogRef.current?.close()} /></div>
      {children}
    </div>}
  </ModalDialog>;
}

function RemoveButton({ label, message, pending, onConfirm }: { label: string; message: string; pending: boolean; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return <>
    <Button ref={buttonRef} type="button" variant="destructive" size="small" fullWidth={false} disabled={pending} className="mr-auto"
      onClick={() => setConfirming(true)}>Remove</Button>
    <ConfirmationDialog open={confirming} title={label} message={message} confirmLabel="Remove" pending={pending}
      returnFocusRef={buttonRef} onClose={() => setConfirming(false)} onConfirm={() => { setConfirming(false); onConfirm(); }} />
  </>;
}

const dayGroups = [{ label: "Weekdays", days: [0, 1, 2, 3, 4] }, { label: "Weekend", days: [5, 6] }] as const;

// A quick action toggles only its own group: it selects the whole group unless the
// whole group is already selected, in which case it clears that group.
function toggleWeekdayGroup(selected: readonly number[], group: readonly number[]) {
  const all = group.every((day) => selected.includes(day));
  return all ? selected.filter((day) => !group.includes(day)) : [...new Set([...selected, ...group])].sort((a, b) => a - b);
}

const scheduleDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function formatScheduleDate(date: string) {
  return scheduleDate.format(new Date(`${date}T00:00:00Z`));
}

// Read-only opening hours of the selected location: the schedule in effect on its local
// date and any later dated schedules, limited to the selected days when there are any.
function OpeningHoursPanel({ location, weekdays }: { location: CoachAvailabilityLocation; weekdays: readonly number[] }) {
  const current = location.opening_hours.find((schedule) => schedule.status === "current");
  return <section aria-label={`${location.name} opening hours`} className="rounded-control border border-border bg-background px-3 py-2.5 text-sm">
    <p className="font-semibold text-foreground">{location.name} — Opening hours <span className="text-xs font-normal text-muted-foreground">({location.timezone})</span></p>
    {!location.opening_hours.length ? <p className="mt-1 text-muted-foreground">Opening hours are not configured for this location.</p> : <>
      {!current && <p className="mt-1 text-muted-foreground">No opening hours apply on {formatScheduleDate(location.today)}.</p>}
      {location.opening_hours.map((schedule) => {
        const groups = groupedWeeklySchedule(location.id, schedule.intervals.map((interval) => ({ ...interval,
          id: `${interval.weekday}-${interval.opens_at_minute}`, location_id: location.id })))
          .map((group) => ({ ...group, weekdays: group.weekdays.filter((day) => !weekdays.length || weekdays.includes(day)) }))
          .filter((group) => group.weekdays.length);
        const period = schedule.status === "current"
          ? `Current schedule${schedule.ends_on ? `, until ${formatScheduleDate(schedule.ends_on)}` : ", no end date"}`
          : `From ${formatScheduleDate(schedule.starts_on)}${schedule.ends_on ? ` until ${formatScheduleDate(schedule.ends_on)}` : ""}`;
        return <div key={schedule.starts_on} className="mt-2">
          <p className="text-xs text-muted-foreground">{period}</p>
          <dl className="mt-1 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {groups.map((group) => <div key={group.weekdays.join()} className="contents">
              <dt className="text-muted-foreground">{weekdayGroupLabel(group.weekdays)}</dt>
              <dd className="text-foreground">{group.intervals.length
                ? group.intervals.map((interval) => formatAvailabilityRange(interval.opens_at_minute, interval.closes_at_minute)).join(", ") : "Closed"}</dd>
            </div>)}
          </dl>
        </div>;
      })}
    </>}
  </section>;
}

// Open windows of each selected day on every applicable date of the validity range:
// working hours must lie inside them. Null until a day and a start date are chosen.
function openWindows(location: CoachAvailabilityLocation, weekdays: readonly number[], from: string, until: string) {
  if (!weekdays.length || !validityDate.safeParse(from).success || (until && (!validityDate.safeParse(until).success || until < from))) return null;
  const range = { from: from < location.today ? location.today : from, until: until || null };
  return weekdays.map((weekday) => ({ weekday, windows: openOnWeekdayThroughout(range, location.opening_hours, weekday) }));
}

const validityDate = z.iso.date();
type WeeklyDraft = { location_id: string; weekdays: number[]; start: number | null; end: number | null; valid_from: string; valid_until: string };

function weeklyTimeOptions(locations: CoachAvailabilityLocation[], draft: WeeklyDraft, savedFrom?: string) {
  const location = locations.find((item) => item.id === draft.location_id && !item.archived);
  const datesAllowed = location && (draft.valid_from >= location.today || draft.valid_from === savedFrom)
    && (!draft.valid_until || draft.valid_until >= location.today);
  const days = datesAllowed ? openWindows(location, draft.weekdays, draft.valid_from, draft.valid_until) : null;
  const endsFor = (start: number) => availabilityMinuteOptions.filter((end) => end > start &&
    days?.every((day) => day.windows.some((window) => window.start <= start && end <= window.end)));
  const starts = days ? availabilityMinuteOptions.filter((start) => endsFor(start).length > 0) : [];
  return { resolved: days !== null, starts, ends: draft.start === null ? [] : endsFor(draft.start) };
}

// One Create/Edit dialog for weekly working hours. Creating applies one interval to any
// combination of weekdays at once; editing changes one existing interval.
export function WeeklyIntervalDialog({ interval, locations, action, open, onOpenChange, readOnly = false }: {
  interval?: CoachWeeklyInterval; locations: CoachAvailabilityLocation[]; action: AvailabilityChangeAction;
  open: boolean; onOpenChange: (open: boolean) => void; readOnly?: boolean;
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { pending, fieldErrors, setFieldErrors, submit } = useAvailabilitySubmit(action);
  const close = () => dialogRef.current?.close();
  const current = locations.filter((location) => !location.archived);
  const editingArchived = interval && !current.some((location) => location.id === interval.location_id);
  const choices = editingArchived ? [...current, ...locations.filter((location) => location.id === interval.location_id)] : current;
  const error = (field: string) => ({ "aria-invalid": Boolean(errors[field]), "aria-describedby": errors[field] ? `${prefix}-${field}-error` : undefined });
  const initialLocation = interval?.location_id ?? "";
  const today = (locations.find((location) => location.id === initialLocation) ?? current[0])?.today ?? "";
  const [draft, setDraft] = useState<WeeklyDraft>({ location_id: initialLocation, weekdays: interval ? [interval.weekday] : [] as number[],
    start: interval?.start_minute ?? null, end: interval?.end_minute ?? null,
    valid_from: interval?.valid_from ?? today, valid_until: interval?.valid_until ?? "" });
  const selectedLocation = locations.find((location) => location.id === draft.location_id);
  const options = weeklyTimeOptions(locations, draft, interval?.valid_from);
  const [timeNotice, setTimeNotice] = useState("");
  const [attempted, setAttempted] = useState(false);
  const dateErrors = {
    ...(selectedLocation && draft.valid_from && draft.valid_from < selectedLocation.today && draft.valid_from !== interval?.valid_from
      ? { valid_from: "Choose today or a later date." } : {}),
    ...(selectedLocation && draft.valid_until && draft.valid_until < selectedLocation.today
      ? { valid_until: "Choose today or a later date." } : {}),
    ...(!validityDate.safeParse(draft.valid_from).success ? { valid_from: "Select a valid start date." } : {}),
    ...(draft.valid_until && (!validityDate.safeParse(draft.valid_until).success ? { valid_until: "Select a valid end date." }
      : draft.valid_until < draft.valid_from ? { valid_until: "Valid until must be on or after Valid from." } : {})),
  };
  const startValid = draft.start !== null && options.starts.includes(draft.start);
  const endValid = startValid && draft.end !== null && options.ends.includes(draft.end);
  const errors: Record<string, string> = { ...fieldErrors, ...dateErrors };
  if (attempted) {
    if (!draft.location_id) errors.location_id = "Select a location.";
    if (!draft.weekdays.length) errors.weekdays = "Select at least one weekday.";
    if (options.starts.length && !startValid) errors.start_minute = draft.start === null ? "Select a start time." : "This start time is outside the location's opening hours.";
    if (startValid && !endValid) errors.end_minute = draft.end === null ? "Select an end time." : "The end time must remain within the same opening interval.";
  }
  function updateDraft(patch: Partial<WeeklyDraft>) {
    const next = { ...draft, ...patch };
    const permitted = weeklyTimeOptions(locations, next, interval?.valid_from);
    setFieldErrors({});
    setAttempted(false);
    setTimeNotice("");
    if (next.start !== null && !permitted.starts.includes(next.start)) {
      next.start = null; next.end = null;
      const location = locations.find((item) => item.id === next.location_id);
      setTimeNotice(permitted.resolved
        ? `The previous time selection is outside ${location?.name ?? "the location"}'s opening hours. Choose another interval.`
        : "The previous time selection was cleared. Select a location, at least one weekday and valid dates before choosing another interval.");
    } else if (next.end !== null && !permitted.ends.includes(next.end)) {
      next.end = null;
      setTimeNotice("The previous ending time was cleared because it must remain within the same opening interval. Choose another ending time.");
    }
    setDraft(next);
  }
  // Ended working hours are history: they can only be removed.
  const ended = interval?.valid_until != null && interval.valid_until < (selectedLocation?.today ?? today);
  return <AvailabilityDialog title={interval ? "Edit working hours" : "Add working hours"} open={open} pending={pending} dialogRef={dialogRef}
    onClose={() => onOpenChange(false)}>
    <form noValidate onSubmit={(event) => {
      event.preventDefault();
      if (pending || readOnly || ended) return;
      setAttempted(true);
      if (!draft.location_id || !draft.weekdays.length || Object.keys(dateErrors).length || !endValid) return;
      const data = new FormData(event.currentTarget);
      const range = { start_minute: minuteValue(data, "start_minute") ?? -1, end_minute: minuteValue(data, "end_minute") ?? -1,
        valid_from: text(data, "valid_from"), valid_until: text(data, "valid_until") || null };
      if (interval) {
        void submit({ operation: "save-weekly", id: interval.id, fields: {
          location_id: text(data, "location_id"), weekday: Number(text(data, "weekday")), ...range,
        } }, "Working hours updated.", close);
        return;
      }
      const weekdays = data.getAll("weekdays").map(Number);
      void submit({ operation: "add-weekly", fields: { location_id: text(data, "location_id"), weekdays, ...range } },
        weekdays.length === 1 ? "Working hours added." : `Working hours added to ${weekdays.length} days.`, close);
    }}>
      <fieldset disabled={pending || readOnly || ended} className="space-y-4">
        <div>
          <label htmlFor={`${prefix}-location_id`} className={labelClass}>Location</label>
          <select id={`${prefix}-location_id`} name="location_id" required className={selectClass}
            value={draft.location_id} onChange={(event) => updateDraft({ location_id: event.target.value })} {...error("location_id")}>
            <option value="" disabled>Select a location</option>
            {choices.map((location) => <option key={location.id} value={location.id} disabled={location.archived}>{locationLabel(location)}</option>)}
          </select>
          <FieldError id={`${prefix}-location_id-error`} message={errors.location_id} />
        </div>
        {!interval && <fieldset aria-describedby={errors.weekdays ? `${prefix}-weekdays-error` : undefined}>
          <legend className={labelClass}>Days</legend>
          <div className="mb-2 flex gap-2">
              {dayGroups.map((group) => <Button key={group.label} type="button" variant="secondary" size="small" fullWidth={false}
                aria-pressed={group.days.every((day) => draft.weekdays.includes(day))}
                className="aria-pressed:border-primary aria-pressed:bg-primary/10"
                onClick={() => updateDraft({ weekdays: toggleWeekdayGroup(draft.weekdays, group.days) })}>
                {group.label}
              </Button>)}
          </div>
          <div className="flex flex-wrap gap-2">
            {availabilityWeekdays.map((day, index) => <label key={day}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border bg-background px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
              <input type="checkbox" name="weekdays" value={index} className="accent-primary" checked={draft.weekdays.includes(index)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  updateDraft({ weekdays: checked
                    ? [...new Set([...draft.weekdays, index])].sort((a, b) => a - b) : draft.weekdays.filter((value) => value !== index) });
                }} />
              {day}
            </label>)}
          </div>
          <FieldError id={`${prefix}-weekdays-error`} message={errors.weekdays} />
        </fieldset>}
        {interval && <div>
          <label htmlFor={`${prefix}-weekday`} className={labelClass}>Day</label>
          <select id={`${prefix}-weekday`} name="weekday" className={selectClass} value={draft.weekdays[0]}
            onChange={(event) => updateDraft({ weekdays: [Number(event.target.value)] })}>
            {availabilityWeekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        </div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${prefix}-valid_from`} className={labelClass}>Valid from</label>
            <Input id={`${prefix}-valid_from`} name="valid_from" type="date" required
              min={(interval && interval.valid_from < (selectedLocation?.today ?? today) ? interval.valid_from : selectedLocation?.today ?? today) || undefined} value={draft.valid_from} onChange={(event) => updateDraft({ valid_from: event.target.value })} {...error("valid_from")} />
            <FieldError id={`${prefix}-valid_from-error`} message={errors.valid_from} />
          </div>
          <div>
            <label htmlFor={`${prefix}-valid_until`} className={labelClass}>Valid until (optional)</label>
            <Input id={`${prefix}-valid_until`} name="valid_until" type="date" min={draft.valid_from || today || undefined}
              value={draft.valid_until} onChange={(event) => updateDraft({ valid_until: event.target.value })} {...error("valid_until")} />
            <FieldError id={`${prefix}-valid_until-error`} message={errors.valid_until} />
          </div>
        </div>
        {selectedLocation && <OpeningHoursPanel location={selectedLocation} weekdays={draft.weekdays} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <MinuteSelect id={`${prefix}-start_minute`} name="start_minute" label="From" value={draft.start}
            onChange={(start) => updateDraft({ start })} disabled={!options.starts.length}
            error={errors.start_minute} allowed={(minute) => options.starts.includes(minute)} />
          <MinuteSelect id={`${prefix}-end_minute`} name="end_minute" label="Until" value={draft.end}
            onChange={(end) => updateDraft({ end })} disabled={!startValid}
            error={errors.end_minute} allowed={(minute) => options.ends.includes(minute)} ends />
        </div>
        {timeNotice && <p role="status" className="text-sm text-foreground">{timeNotice}</p>}
        <p className={hintClass}>Local time at the selected location, in 30-minute steps, within its opening hours on every date from Valid from.
          Dates are inclusive; without an end date the hours continue until changed.</p>
        {options.resolved && !options.starts.length && <p role="status" className="text-sm text-foreground">
          No common opening hours are available for the selected days and dates.</p>}
        <FieldError id={`${prefix}-form-error`} message={errors.form} />
      </fieldset>
      <DialogFooter>
        {interval && <RemoveButton label="Remove working hours" pending={pending}
          message={`Remove ${availabilityWeekdays[interval.weekday]} ${formatAvailabilityMinute(interval.start_minute)}–${formatAvailabilityMinute(interval.end_minute)}?`}
          onConfirm={() => void submit({ operation: "remove-weekly", id: interval.id }, "Working hours removed.", close)} />}
        {!readOnly && !ended && <Button type="submit" fullWidth={false} disabled={pending || (options.resolved && !options.starts.length)} aria-busy={pending}>{pending ? "Saving…" : "Save"}</Button>}
      </DialogFooter>
    </form>
  </AvailabilityDialog>;
}

export const exceptionKindLabels: Record<CoachAvailabilityExceptionKind, string> = {
  unavailable: "Time off", available: "Extra availability",
};

// One Create/Edit dialog for a date exception. Unavailability applies at every location.
export function ExceptionDialog({ exception, kind: initialKind = "unavailable", locations, today, horizon, action, open, onOpenChange, readOnly = false }: {
  exception?: CoachAvailabilityExceptionRow; kind?: CoachAvailabilityExceptionKind; locations: CoachAvailabilityLocation[]; today: string; horizon: string;
  action: AvailabilityChangeAction; open: boolean; onOpenChange: (open: boolean) => void; readOnly?: boolean;
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { pending, fieldErrors, submit } = useAvailabilitySubmit(action);
  const kind = exception?.kind ?? initialKind;
  const [from, setFrom] = useState(exception?.date ?? "");
  const [until, setUntil] = useState(exception?.until_date ?? exception?.date ?? "");
  const multiDay = kind === "unavailable" && from !== until;
  const [wholeDay, setWholeDay] = useState(exception ? exception.start_minute === null : true);
  const close = () => dialogRef.current?.close();
  const current = locations.filter((location) => !location.archived);
  const timed = kind === "available" || (!wholeDay && !multiDay);
  const error = (field: string) => ({ "aria-invalid": Boolean(fieldErrors[field]), "aria-describedby": fieldErrors[field] ? `${prefix}-${field}-error` : undefined });
  return <AvailabilityDialog title={`${exception ? "Edit" : "Add"} ${kind === "unavailable" ? "time off" : "extra availability"}`} open={open} pending={pending} dialogRef={dialogRef}
    onClose={() => onOpenChange(false)}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void submit({ operation: "save-exception", ...exception && { id: exception.id }, fields: {
        date: text(data, "date"), until_date: kind === "unavailable" ? text(data, "until_date") : text(data, "date"), kind, location_id: kind === "available" ? text(data, "location_id") || null : null,
        start_minute: timed ? minuteValue(data, "start_minute") ?? -1 : null, end_minute: timed ? minuteValue(data, "end_minute") ?? -1 : null,
        note: text(data, "note"),
      } }, `${exceptionKindLabels[kind]} ${exception ? "updated" : "added"}.`, close);
    }}>
      <fieldset disabled={pending || readOnly} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${prefix}-date`} className={labelClass}>{kind === "unavailable" ? "From date" : "Date"}</label>
            <Input id={`${prefix}-date`} name="date" type="date" required min={exception && exception.date < today ? exception.date : today} max={horizon} value={from}
              onChange={(event) => { const next = event.target.value; setFrom(next); if (!until || until === from) setUntil(next); }} {...error("date")} />
            <FieldError id={`${prefix}-date-error`} message={fieldErrors.date} />
          </div>
          {kind === "unavailable" && <div>
            <label htmlFor={`${prefix}-until_date`} className={labelClass}>Until date (inclusive)</label>
            <Input id={`${prefix}-until_date`} name="until_date" type="date" required min={from || today} max={horizon} value={until}
              onChange={(event) => setUntil(event.target.value)} {...error("until_date")} />
            <FieldError id={`${prefix}-until_date-error`} message={fieldErrors.until_date} />
          </div>}
        </div>
        {kind === "unavailable" ? <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={wholeDay || multiDay} disabled={multiDay} onChange={(event) => setWholeDay(event.target.checked)} className="accent-primary" />
          Whole day, at every location
        </label> : <div>
          <label htmlFor={`${prefix}-location_id`} className={labelClass}>Location</label>
          <select id={`${prefix}-location_id`} name="location_id" required className={selectClass}
            defaultValue={exception?.location_id ?? (current.length === 1 ? current[0].id : "")} {...error("location_id")}>
            <option value="" disabled>Select a location</option>
            {current.map((location) => <option key={location.id} value={location.id}>{locationLabel(location)}</option>)}
          </select>
          <FieldError id={`${prefix}-location_id-error`} message={fieldErrors.location_id} />
        </div>}
        {timed && <div className="grid gap-4 sm:grid-cols-2">
          <MinuteSelect id={`${prefix}-start_minute`} name="start_minute" label="From" defaultValue={exception?.start_minute} error={fieldErrors.start_minute} />
          <MinuteSelect id={`${prefix}-end_minute`} name="end_minute" label="Until" defaultValue={exception?.end_minute} error={fieldErrors.end_minute} ends />
        </div>}
        <p className={hintClass}>
          {kind === "unavailable" ? "Replaces regular working hours for this time at every location." : "Replaces regular working hours for this time with the selected location."}
          {" "}Local time at each location.
        </p>
        <div>
          <label htmlFor={`${prefix}-note`} className={labelClass}>Note <span className="font-normal text-muted-foreground">(optional, not public)</span></label>
          <Input id={`${prefix}-note`} name="note" maxLength={200} defaultValue={exception?.note ?? ""} {...error("note")} />
          <FieldError id={`${prefix}-note-error`} message={fieldErrors.note} />
        </div>
        <FieldError id={`${prefix}-form-error`} message={fieldErrors.form ?? fieldErrors.kind} />
      </fieldset>
      <DialogFooter>
        {exception && <RemoveButton label={`Remove ${kind === "unavailable" ? "time off" : "extra availability"}`} pending={pending} message={`Remove this period (${exception.date} – ${exception.until_date ?? exception.date})?`}
          onConfirm={() => void submit({ operation: "remove-exception", id: exception.id }, `${exceptionKindLabels[kind]} removed.`, close)} />}
        {!readOnly && <Button type="submit" fullWidth={false} disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</Button>}
      </DialogFooter>
    </form>
  </AvailabilityDialog>;
}
