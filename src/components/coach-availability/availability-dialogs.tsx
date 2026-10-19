"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DialogFooter, DialogHeader } from "@/components/dialog-layout";
import { Input } from "@/components/input";
import { ModalDialog } from "@/components/modal-dialog";
import type { CoachAvailabilityExceptionRow, CoachAvailabilityLocation, CoachWeeklyInterval } from "@/lib/coaching/availability";
import {
  availabilityFailureMessages, availabilityMinuteOptions, availabilityOverlapMessage, availabilityWeekdays, formatAvailabilityMinute,
  type AvailabilityChange, type AvailabilityMutationResult, type CoachAvailabilityExceptionKind,
} from "@/lib/coaching/availability-validation";

export type AvailabilityChangeAction = (change: AvailabilityChange) => Promise<AvailabilityMutationResult>;

const selectClass = "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20";
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
      } else if (result.reason === "overlap" || result.reason === "out-of-range" || result.reason === "invalid-location") {
        toast.dismiss(notification);
        setFieldErrors(result.reason === "overlap" ? { form: availabilityOverlapMessage(result.weekdays) }
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

function MinuteSelect({ id, name, label, defaultValue, error, ends }: {
  id: string; name: string; label: string; defaultValue?: number | null; error?: string; ends?: boolean;
}) {
  return <div>
    <label htmlFor={id} className={labelClass}>{label}</label>
    <select id={id} name={name} required className={selectClass} defaultValue={defaultValue ?? ""}
      aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      <option value="" disabled>Select</option>
      {availabilityMinuteOptions.filter((minute) => ends ? minute > 0 : minute < 1440)
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

// One Create/Edit dialog for weekly working hours. Creating applies one interval to any
// combination of weekdays at once; editing changes one existing interval.
export function WeeklyIntervalDialog({ interval, locations, action, open, onOpenChange, readOnly = false }: {
  interval?: CoachWeeklyInterval; locations: CoachAvailabilityLocation[]; action: AvailabilityChangeAction;
  open: boolean; onOpenChange: (open: boolean) => void; readOnly?: boolean;
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { pending, fieldErrors, submit } = useAvailabilitySubmit(action);
  const close = () => dialogRef.current?.close();
  const current = locations.filter((location) => !location.archived);
  const editingArchived = interval && !current.some((location) => location.id === interval.location_id);
  const choices = editingArchived ? [...current, ...locations.filter((location) => location.id === interval.location_id)] : current;
  const error = (field: string) => ({ "aria-invalid": Boolean(fieldErrors[field]), "aria-describedby": fieldErrors[field] ? `${prefix}-${field}-error` : undefined });
  return <AvailabilityDialog title={interval ? "Edit working hours" : "Add working hours"} open={open} pending={pending} dialogRef={dialogRef}
    onClose={() => onOpenChange(false)}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const range = { start_minute: minuteValue(data, "start_minute") ?? -1, end_minute: minuteValue(data, "end_minute") ?? -1 };
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
      <fieldset disabled={pending || readOnly} className="space-y-4">
        {!interval && <fieldset aria-describedby={fieldErrors.weekdays ? `${prefix}-weekdays-error` : undefined}>
          <legend className={labelClass}>Days</legend>
          <div className="flex flex-wrap gap-2">
            {availabilityWeekdays.map((day, index) => <label key={day}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border bg-background px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
              <input type="checkbox" name="weekdays" value={index} className="accent-primary" />
              {day}
            </label>)}
          </div>
          <FieldError id={`${prefix}-weekdays-error`} message={fieldErrors.weekdays} />
        </fieldset>}
        <div className="grid gap-4 sm:grid-cols-2">
          {interval && <div>
            <label htmlFor={`${prefix}-weekday`} className={labelClass}>Day</label>
            <select id={`${prefix}-weekday`} name="weekday" className={selectClass} defaultValue={interval.weekday}>
              {availabilityWeekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </div>}
          <div className={interval ? undefined : "sm:col-span-2"}>
            <label htmlFor={`${prefix}-location_id`} className={labelClass}>Location</label>
            <select id={`${prefix}-location_id`} name="location_id" required className={selectClass}
              defaultValue={interval?.location_id ?? (current.length === 1 ? current[0].id : "")} {...error("location_id")}>
              <option value="" disabled>Select a location</option>
              {choices.map((location) => <option key={location.id} value={location.id} disabled={location.archived}>{locationLabel(location)}</option>)}
            </select>
            <FieldError id={`${prefix}-location_id-error`} message={fieldErrors.location_id} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <MinuteSelect id={`${prefix}-start_minute`} name="start_minute" label="From" defaultValue={interval?.start_minute} error={fieldErrors.start_minute} />
          <MinuteSelect id={`${prefix}-end_minute`} name="end_minute" label="Until" defaultValue={interval?.end_minute} error={fieldErrors.end_minute} ends />
        </div>
        <p className={hintClass}>Local time at the selected location, in 30-minute steps.</p>
        <FieldError id={`${prefix}-form-error`} message={fieldErrors.form} />
      </fieldset>
      <DialogFooter>
        {interval && <RemoveButton label="Remove working hours" pending={pending}
          message={`Remove ${availabilityWeekdays[interval.weekday]} ${formatAvailabilityMinute(interval.start_minute)}–${formatAvailabilityMinute(interval.end_minute)}?`}
          onConfirm={() => void submit({ operation: "remove-weekly", id: interval.id }, "Working hours removed.", close)} />}
        {!readOnly && <Button type="submit" fullWidth={false} disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</Button>}
      </DialogFooter>
    </form>
  </AvailabilityDialog>;
}

export const exceptionKindLabels: Record<CoachAvailabilityExceptionKind, string> = {
  unavailable: "Unavailable", available: "Additional hours",
};

// One Create/Edit dialog for a date exception. Unavailability applies at every location.
export function ExceptionDialog({ exception, locations, today, horizon, action, open, onOpenChange, readOnly = false }: {
  exception?: CoachAvailabilityExceptionRow; locations: CoachAvailabilityLocation[]; today: string; horizon: string;
  action: AvailabilityChangeAction; open: boolean; onOpenChange: (open: boolean) => void; readOnly?: boolean;
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { pending, fieldErrors, submit } = useAvailabilitySubmit(action);
  const [kind, setKind] = useState<CoachAvailabilityExceptionKind>(exception?.kind ?? "unavailable");
  const [wholeDay, setWholeDay] = useState(exception ? exception.start_minute === null : true);
  const close = () => dialogRef.current?.close();
  const current = locations.filter((location) => !location.archived);
  const timed = kind === "available" || !wholeDay;
  const error = (field: string) => ({ "aria-invalid": Boolean(fieldErrors[field]), "aria-describedby": fieldErrors[field] ? `${prefix}-${field}-error` : undefined });
  return <AvailabilityDialog title={exception ? "Edit date exception" : "Add date exception"} open={open} pending={pending} dialogRef={dialogRef}
    onClose={() => onOpenChange(false)}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void submit({ operation: "save-exception", ...exception && { id: exception.id }, fields: {
        date: text(data, "date"), kind, location_id: kind === "available" ? text(data, "location_id") || null : null,
        start_minute: timed ? minuteValue(data, "start_minute") ?? -1 : null, end_minute: timed ? minuteValue(data, "end_minute") ?? -1 : null,
        note: text(data, "note"),
      } }, exception ? "Date exception updated." : "Date exception added.", close);
    }}>
      <fieldset disabled={pending || readOnly} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${prefix}-date`} className={labelClass}>Date</label>
            <Input id={`${prefix}-date`} name="date" type="date" required min={today} max={horizon} defaultValue={exception?.date ?? ""} {...error("date")} />
            <FieldError id={`${prefix}-date-error`} message={fieldErrors.date} />
          </div>
          <div>
            <label htmlFor={`${prefix}-kind`} className={labelClass}>Type</label>
            <select id={`${prefix}-kind`} name="kind" className={selectClass} value={kind}
              onChange={(event) => setKind(event.target.value === "available" ? "available" : "unavailable")}>
              <option value="unavailable">Unavailable (vacation, appointment)</option>
              <option value="available">Additional hours</option>
            </select>
          </div>
        </div>
        {kind === "unavailable" ? <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={wholeDay} onChange={(event) => setWholeDay(event.target.checked)} className="accent-primary" />
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
        {exception && <RemoveButton label="Remove date exception" pending={pending} message={`Remove the exception on ${exception.date}?`}
          onConfirm={() => void submit({ operation: "remove-exception", id: exception.id }, "Date exception removed.", close)} />}
        {!readOnly && <Button type="submit" fullWidth={false} disabled={pending} aria-busy={pending}>{pending ? "Saving…" : "Save"}</Button>}
      </DialogFooter>
    </form>
  </AvailabilityDialog>;
}
