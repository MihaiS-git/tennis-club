"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { ReservationTimetable, type ReservationTimetableDay } from "@/components/reservation-timetable";
import { localToday } from "@/lib/courts/local-time";
import { reservationEditSchema, reservationReasonSchema, reservationSelectionForInterval, selectReservationCell,
  type ReservationCell, type ReservationSelection } from "@/lib/reservations/domain";

export type EditableReservation = {
  id: string; court_id: string; booking_date: string; starts_at_minute: number; ends_at_minute: number;
  reason: string | null; location_name: string; location_timezone: string; court_name: string;
};
export type ReservationEditDraft = { date: string; selection: ReservationSelection | null; reason: string; inProgress: boolean };
export type ReservationEditSaveResult = { ok: true; pending?: boolean; message?: string } | { ok: false; message: string; stale?: boolean; fieldErrors?: Record<string, string> };

const fieldClass = "min-h-10 w-full rounded-control border border-border-strong bg-background px-3 text-sm text-foreground disabled:bg-surface-muted disabled:text-muted-foreground";
const scheduleSchema = reservationEditSchema.options[1].shape.schedule;

function selectionForDay(day: ReservationTimetableDay, desired: Pick<ReservationSelection, "courtId" | "startMinute" | "endMinute"> | null) {
  const grid = day.courts.find((item) => item.court.id.toLowerCase() === desired?.courtId.toLowerCase());
  return grid && desired ? reservationSelectionForInterval({ courtId: grid.court.id, times: day.times, cells: grid.cells },
    desired.startMinute, desired.endMinute) : null;
}

export function ReservationEditForm<Day extends ReservationTimetableDay = ReservationTimetableDay>({ reservation, inProgress, loadAvailability, initialAvailability, onCancel, onSave, onSaved, onStale, onPendingChange, scheduleOnly = false, renderScheduleDetails, renderTimetable, canSave }: {
  scheduleOnly?: boolean;
  // Replaces the default interval timetable, e.g. lesson starts of a fixed length.
  renderTimetable?: (input: { day: Day; date: string; selection: ReservationSelection | null;
    select: (selection: ReservationSelection | null) => void; disabled: boolean }) => ReactNode;
  renderScheduleDetails?: (draft: ReservationEditDraft, pending: boolean) => ReactNode;
  canSave?: (draft: ReservationEditDraft) => boolean;
  reservation: EditableReservation;
  inProgress: boolean;
  loadAvailability: (reservationId: string, date: string) => Promise<{ day: Day }>;
  initialAvailability?: { reservationId: string; date: string; day: Day };
  onCancel: () => void;
  onSave?: (draft: ReservationEditDraft) => Promise<ReservationEditSaveResult>;
  onSaved?: () => Promise<void>;
  onStale?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const prefix = useId();
  const initialDay = !inProgress && initialAvailability?.reservationId === reservation.id
    && initialAvailability.date === reservation.booking_date && z.iso.date().safeParse(reservation.booking_date).success
    && reservation.booking_date >= localToday(reservation.location_timezone, new Date()) ? initialAvailability.day : null;
  const [date, setDate] = useState(reservation.booking_date);
  const [availability, setAvailability] = useState<{
    day: Day | null; reservationId: string; date: string; loader: typeof loadAvailability; refreshKey: number; error: string;
  } | null>(() => initialDay ? { day: initialDay, reservationId: reservation.id, date: reservation.booking_date,
    loader: loadAvailability, refreshKey: 0, error: "" } : null);
  const [selection, setSelection] = useState<ReservationSelection | null>(() => initialDay ? selectionForDay(initialDay,
    { courtId: reservation.court_id, startMinute: reservation.starts_at_minute, endMinute: reservation.ends_at_minute }) : null);
  const [reason, setReason] = useState(reservation.reason ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const firstLoad = useRef(!initialDay);
  const preloaded = useRef(initialDay ? { reservationId: reservation.id, date: reservation.booking_date, loader: loadAvailability } : null);
  const submitting = useRef(false);
  const today = localToday(reservation.location_timezone, new Date());
  const validDate = z.iso.date().safeParse(date).success && date >= today;
  const currentAvailability = availability?.reservationId === reservation.id && availability.date === date && availability.loader === loadAvailability
    && availability.refreshKey === refreshKey ? availability : null;
  const day = currentAvailability?.day ?? null;
  const availabilityError = currentAvailability?.error ?? "";
  const loading = !inProgress && validDate && !currentAvailability;

  useEffect(() => {
    if (preloaded.current) {
      if (preloaded.current.reservationId === reservation.id && preloaded.current.date === date
        && preloaded.current.loader === loadAvailability && refreshKey === 0) return;
      preloaded.current = null;
    }
    if (inProgress || !z.iso.date().safeParse(date).success || date < localToday(reservation.location_timezone, new Date())) return;
    let disposed = false;
    const notification = toast.loading("Loading court availability…");
    loadAvailability(reservation.id, date).then((value) => {
      if (disposed) return;
      toast.dismiss(notification);
      setAvailability({ day: value.day, reservationId: reservation.id, date, loader: loadAvailability, refreshKey, error: "" });
      const initialSelection = firstLoad.current && date === reservation.booking_date
        ? { courtId: reservation.court_id, startMinute: reservation.starts_at_minute, endMinute: reservation.ends_at_minute }
        : null;
      setSelection((current) => selectionForDay(value.day, initialSelection ?? current));
      firstLoad.current = false;
    }).catch(() => {
      if (!disposed) {
        setAvailability({ day: null, reservationId: reservation.id, date, loader: loadAvailability, refreshKey, error: "Unable to load court availability. Try again." });
        toast.error("Unable to load court availability. Try again.", { id: notification,
          action: { label: "Retry", onClick: () => setRefreshKey((key) => key + 1) } });
      }
    });
    return () => { disposed = true; toast.dismiss(notification); };
  }, [date, inProgress, loadAvailability, refreshKey, reservation.booking_date, reservation.court_id,
    reservation.ends_at_minute, reservation.id, reservation.location_timezone, reservation.starts_at_minute]);

  function changeDate(value: string) {
    setDate(value); setAvailability(null); setSelection(null);
  }

  function choose(courtId: string, cells: ReservationCell[], row: number) {
    if (!day) return;
    setSelection((current) => selectReservationCell({ courtId, times: day.times, cells }, current, row));
  }

  const selectedGrid = day?.courts.find((item) => item.court.id.toLowerCase() === selection?.courtId.toLowerCase());
  const selectedCourt = selectedGrid?.court;
  const isCurrent = inProgress || selection?.courtId.toLowerCase() === reservation.court_id.toLowerCase()
    && date === reservation.booking_date && selection.startMinute === reservation.starts_at_minute
    && selection.endMinute === reservation.ends_at_minute;
  const dirty = !isCurrent || (!scheduleOnly && reason.trim() !== (reservation.reason ?? "").trim());
  const validReason = scheduleOnly || reservationReasonSchema.safeParse(reason).success;
  const validSchedule = inProgress || validDate && !loading && Boolean(selection && selectedGrid
    && z.uuid().safeParse(selection.courtId).success
    && (scheduleOnly || scheduleSchema.safeParse({ courtId: selection.courtId, date,
      startMinute: selection.startMinute, endMinute: selection.endMinute, reason }).success)
    && reservationSelectionForInterval({ courtId: selectedGrid.court.id, times: day?.times ?? [], cells: selectedGrid.cells },
      selection.startMinute, selection.endMinute));
  const draft = { date, selection, reason, inProgress };
  const ready = Boolean(onSave && dirty && validReason && validSchedule && (canSave?.(draft) ?? true));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || !onSave || !ready) return;
    setFieldErrors({});
    submitting.current = true;
    setPending(true); onPendingChange?.(true);
    const notification = toast.loading("Saving changes…");
    let saved = false;
    let staleMessage = "";
    try {
      const result = await onSave({ date, selection, reason, inProgress });
      if (result.ok) {
        if (result.pending) { toast.info(result.message ?? "Complete the additional payment to update your booking.", { id: notification }); return; }
        saved = true;
        await onSaved?.();
        toast.success(scheduleOnly ? "Booking updated." : "Reservation updated.", { id: notification });
        return;
      }
      if (result.stale) {
        staleMessage = result.message;
        await onStale?.();
        toast.warning(result.message, { id: notification });
        return;
      }
      if (Object.values(result.fieldErrors ?? {}).some(Boolean)) toast.dismiss(notification);
      else toast.error(result.message, { id: notification });
      setFieldErrors(result.fieldErrors ?? {});
      if (result.message.startsWith("That court is no longer available")) setRefreshKey((key) => key + 1);
    } catch {
      if (saved) toast.warning(scheduleOnly ? "Booking updated. Unable to refresh its details." : "Reservation updated. Unable to refresh its details.",
        { id: notification, description: "Close and reopen the details to see the saved changes." });
      else if (staleMessage) toast.warning(staleMessage, { id: notification, description: "Unable to refresh details. Close and reopen them before trying again." });
      else toast.error("Unable to save this reservation. Refresh the details before trying again.", { id: notification });
    }
    finally { submitting.current = false; setPending(false); onPendingChange?.(false); }
  }

  return <form onSubmit={submit} className="mt-4 space-y-3">
    <div className="text-sm"><span className="block font-semibold text-primary">Location</span><span className="mt-1 block">{reservation.location_name}</span></div>
    {inProgress ? <div className="rounded-control bg-surface-muted p-3 text-sm text-muted-foreground">
      <p>This reservation is in progress. Its court, date and time cannot be changed.</p>
      <p className="mt-1">{reservation.court_name} · {reservation.booking_date} · {minuteToTime(reservation.starts_at_minute)}–{minuteToTime(reservation.ends_at_minute)} ({reservation.location_timezone})</p>
    </div> : <>
      <label className="block space-y-1 text-sm font-semibold text-primary"><span>Date</span>
        <input type="date" value={date} min={today} disabled={pending} aria-invalid={!validDate || Boolean(fieldErrors.date)}
          aria-describedby={`${prefix}-date-error`} onChange={(event) => changeDate(event.target.value)} className={fieldClass} />
      </label>
      <p id={`${prefix}-date-error`} className="text-sm text-danger">{!validDate ? "Choose a valid date from today onward." : fieldErrors.date}</p>
      <p className="text-xs text-muted-foreground">Times shown in {reservation.location_timezone}.</p>
      {loading && <div aria-busy="true" className="min-h-20" />}
      {availabilityError && <button type="button" className="text-sm font-semibold underline" onClick={() => setRefreshKey((key) => key + 1)}>Retry loading availability</button>}
      {day && (renderTimetable ? renderTimetable({ day, date, selection, select: setSelection, disabled: pending })
        : <ReservationTimetable day={day} date={date} selection={selection} onChoose={choose} disabled={pending} />)}
      {(fieldErrors.courtId || fieldErrors.startMinute || fieldErrors.endMinute) && <p role="alert" className="text-sm text-danger">{fieldErrors.courtId || fieldErrors.startMinute || fieldErrors.endMinute}</p>}
      {selection && selectedCourt && <section aria-label="Selected reservation" className="rounded-control border border-border bg-surface-muted p-3 text-sm">
        <p className="font-semibold text-primary">{isCurrent ? "Current reservation" : "Selected"}</p>
        <p className="mt-1">{selectedCourt.name} · {minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.endMinute - selection.startMinute} min</p>
      </section>}
    </>}
    {renderScheduleDetails?.(draft, pending)}
    {!scheduleOnly && <div><label className="block space-y-1 text-sm font-semibold text-primary"><span>Reason</span>
      <input value={reason} maxLength={255} disabled={pending} aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? `${prefix}-reason-error` : undefined}
        onChange={(event) => { setReason(event.target.value); setFieldErrors((current) => ({ ...current, reason: "" })); }} className={fieldClass} />
    </label>
      {fieldErrors.reason && <p id={`${prefix}-reason-error`} role="alert" className="mt-1 text-xs text-danger">{fieldErrors.reason}</p>}
    </div>}
    {fieldErrors.form && <p role="alert" className="text-xs text-danger">{fieldErrors.form}</p>}
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" disabled={pending} onClick={onCancel} className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Cancel</button>
      <button type="submit" disabled={!ready || pending} aria-busy={pending} className="min-h-10 rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {pending ? "Saving…" : "Save changes"}
      </button>
    </div>
  </form>;
}
