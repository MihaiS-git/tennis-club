"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { ReservationTimetable, type ReservationTimetableDay } from "@/components/reservation-timetable";
import { localToday } from "@/lib/courts/local-time";
import { reservationReasonSchema, reservationSelectionForInterval, selectReservationCell,
  type ReservationCell, type ReservationSelection } from "@/lib/reservations/domain";

export type EditableReservation = {
  id: string; court_id: string; booking_date: string; starts_at_minute: number; ends_at_minute: number;
  reason: string | null; location_name: string; location_timezone: string; court_name: string;
};
export type ReservationEditDraft = { date: string; selection: ReservationSelection | null; reason: string; inProgress: boolean };
export type ReservationEditSaveResult = { ok: true } | { ok: false; message: string; stale?: boolean; fieldErrors?: Record<string, string> };

const fieldClass = "min-h-10 w-full rounded-control border border-border-strong bg-background px-3 text-sm text-foreground disabled:bg-surface-muted disabled:text-muted-foreground";

export function ReservationEditForm({ reservation, inProgress, loadAvailability, onCancel, onSave, onSaved, onStale, onPendingChange }: {
  reservation: EditableReservation;
  inProgress: boolean;
  loadAvailability: (reservationId: string, date: string) => Promise<{ day: ReservationTimetableDay }>;
  onCancel: () => void;
  onSave?: (draft: ReservationEditDraft) => Promise<ReservationEditSaveResult>;
  onSaved?: () => Promise<void>;
  onStale?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [date, setDate] = useState(reservation.booking_date);
  const [day, setDay] = useState<ReservationTimetableDay | null>(null);
  const [selection, setSelection] = useState<ReservationSelection | null>(null);
  const [reason, setReason] = useState(reservation.reason ?? "");
  const [error, setError] = useState("");
  const [availabilityError, setAvailabilityError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const firstLoad = useRef(true);
  const today = localToday(reservation.location_timezone, new Date());

  useEffect(() => {
    if (inProgress || !z.iso.date().safeParse(date).success || date < localToday(reservation.location_timezone, new Date())) return;
    let disposed = false;
    loadAvailability(reservation.id, date).then((value) => {
      if (disposed) return;
      setDay(value.day);
      setAvailabilityError("");
      const initialSelection = firstLoad.current && date === reservation.booking_date
        ? { courtId: reservation.court_id, startMinute: reservation.starts_at_minute, endMinute: reservation.ends_at_minute }
        : null;
      setSelection((current) => {
        const desired = initialSelection ?? current;
        const grid = value.day.courts.find((item) => item.court.id === desired?.courtId);
        return grid && desired ? reservationSelectionForInterval({ courtId: grid.court.id, times: value.day.times, cells: grid.cells },
          desired.startMinute, desired.endMinute) : null;
      });
      firstLoad.current = false;
      setLoading(false);
    }).catch(() => {
      if (!disposed) { setDay(null); setAvailabilityError("Unable to load court availability. Try again."); setLoading(false); }
    });
    return () => { disposed = true; };
  }, [date, inProgress, loadAvailability, refreshKey, reservation.booking_date, reservation.court_id,
    reservation.ends_at_minute, reservation.id, reservation.location_timezone, reservation.starts_at_minute]);

  function changeDate(value: string) {
    setDate(value); setDay(null); setSelection(null); setAvailabilityError(""); setError("");
    if (z.iso.date().safeParse(value).success && value >= today) setLoading(true);
    else setLoading(false);
  }

  function choose(courtId: string, cells: ReservationCell[], row: number) {
    if (!day) return;
    setSelection((current) => selectReservationCell({ courtId, times: day.times, cells }, current, row));
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !onSave) return;
    setError(""); setFieldErrors({});
    if (!inProgress && (!selection || !day || loading)) { setError("Choose an available court and interval."); return; }
    const validReason = reservationReasonSchema.safeParse(reason);
    if (!validReason.success) {
      setError("Check the highlighted fields.");
      setFieldErrors({ reason: validReason.error.issues[0]?.message ?? "Enter a reason." });
      return;
    }
    setPending(true); onPendingChange?.(true);
    try {
      const result = await onSave({ date, selection, reason, inProgress });
      if (result.ok) { await onSaved?.(); return; }
      if (result.stale) { await onStale?.(); return; }
      setError(result.message);
      setFieldErrors(result.fieldErrors ?? {});
      if (result.message.startsWith("That court is no longer available")) { setLoading(true); setRefreshKey((key) => key + 1); }
    } catch { setError("Unable to save this reservation. Refresh the details before trying again."); }
    finally { setPending(false); onPendingChange?.(false); }
  }

  const selectedCourt = day?.courts.find((item) => item.court.id === selection?.courtId)?.court;
  const isCurrent = selection?.courtId === reservation.court_id && date === reservation.booking_date
    && selection.startMinute === reservation.starts_at_minute && selection.endMinute === reservation.ends_at_minute;

  return <form onSubmit={submit} className="mt-4 space-y-3">
    <p role={error ? "alert" : undefined} className={`min-h-10 rounded-control px-3 py-2 text-sm text-danger ${error ? "bg-danger-background" : ""}`}>{error}</p>
    <div className="text-sm"><span className="block font-semibold text-primary">Location</span><span className="mt-1 block">{reservation.location_name}</span></div>
    {inProgress ? <div className="rounded-control bg-surface-muted p-3 text-sm text-muted-foreground">
      <p>This reservation is in progress. Its court, date and time cannot be changed.</p>
      <p className="mt-1">{reservation.court_name} · {reservation.booking_date} · {minuteToTime(reservation.starts_at_minute)}–{minuteToTime(reservation.ends_at_minute)} ({reservation.location_timezone})</p>
    </div> : <>
      <label className="block space-y-1 text-sm font-semibold text-primary"><span>Date</span>
        <input type="date" value={date} min={today} disabled={pending} onChange={(event) => changeDate(event.target.value)} className={fieldClass} />
      </label>
      <p className="text-xs text-muted-foreground">Times shown in {reservation.location_timezone}.</p>
      {date && (!z.iso.date().safeParse(date).success || date < today) && <p role="alert" className="text-sm text-danger">Choose a valid date from today onward.</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading court availability…</p>}
      {availabilityError && <p role="alert" className="text-sm text-danger">{availabilityError} <button type="button" className="font-semibold underline" onClick={() => { setLoading(true); setRefreshKey((key) => key + 1); }}>Retry</button></p>}
      {day && <ReservationTimetable day={day} date={date} selection={selection} onChoose={choose} disabled={pending} />}
      {selection && selectedCourt && <section aria-label="Selected reservation" className="rounded-control border border-border bg-surface-muted p-3 text-sm">
        <p className="font-semibold text-primary">{isCurrent ? "Current reservation" : "Selected"}</p>
        <p className="mt-1">{selectedCourt.name} · {minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.endMinute - selection.startMinute} min</p>
      </section>}
    </>}
    <label className="block space-y-1 text-sm font-semibold text-primary"><span>Reason</span>
      <input value={reason} maxLength={255} disabled={pending} onChange={(event) => setReason(event.target.value)} className={fieldClass} />
    </label>
    <p className="min-h-4 text-xs text-danger">{fieldErrors.reason || fieldErrors.startMinute}</p>
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" disabled={pending} onClick={onCancel} className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Cancel</button>
      <button type="submit" disabled={!onSave || pending || loading || (!inProgress && !day)} className="min-h-10 rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {pending ? "Saving…" : "Save changes"}
      </button>
    </div>
  </form>;
}
