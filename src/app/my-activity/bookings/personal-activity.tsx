"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import { ReservationDetailFieldsView } from "@/components/reservation-details";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { formatMoney } from "@/lib/pricing/money";
import { isReservationInProgress, isReservationUpcoming, type PersonalReservation } from "@/lib/reservations/personal";
import { cancelOwnReservationAction, loadPersonalActivityAction } from "./actions";
import { ReservationEditForm } from "./reservation-edit-form";

type Activity = { upcoming: PersonalReservation[]; bookings: PersonalCustomerBooking[] };
type CourtActivity = { kind: "booking"; row: PersonalCustomerBooking } | { kind: "reservation"; row: PersonalReservation };

function startInstant(row: PersonalCustomerBooking | PersonalReservation) {
  const [year, month, day] = row.booking_date.split("-").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, Math.floor(row.starts_at_minute / 60), row.starts_at_minute % 60);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: row.location_timezone, timeZoneName: "shortOffset" });
  const offsetAt = (instant: number) => {
    const label = formatter.formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(label);
    return match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60_000 : 0;
  };
  const first = localAsUtc - offsetAt(localAsUtc);
  return localAsUtc - offsetAt(first);
}

function sortedActivity(activity: Activity): CourtActivity[] {
  return [
    ...activity.bookings.map((row): CourtActivity => ({ kind: "booking", row })),
    ...activity.upcoming.map((row): CourtActivity => ({ kind: "reservation", row })),
  ].sort((a, b) => startInstant(a.row) - startInstant(b.row)
    || a.kind.localeCompare(b.kind) || a.row.id.localeCompare(b.row.id));
}

export function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function timeLabel(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function timestampLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(value));
}

export function ReservationDetails({ reservation: selected }: { reservation: PersonalReservation }) {
  return <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
    <ReservationDetailFieldsView reservation={selected} />
    <dt className="text-muted-foreground">Created by</dt><dd>{selected.created_by_user_id ? selected.creator_name || "You" : "Not recorded"}</dd>
    {selected.status === "cancelled" && <>
      <dt className="text-muted-foreground">Status</dt><dd>Cancelled</dd>
      <dt className="text-muted-foreground">Cancelled at</dt><dd>{selected.cancelled_at ? timestampLabel(selected.cancelled_at, selected.location_timezone) : "Not recorded"}</dd>
      <dt className="text-muted-foreground">Cancelled by</dt><dd>{selected.cancelled_by_name || "Club staff"}</dd>
    </>}
  </dl>;
}

export function PersonalActivity({ staff, userId }: { staff: boolean; userId?: string }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PersonalReservation | null>(null);
  const [selectedBooking, setSelectedBooking] = useState<PersonalCustomerBooking | null>(null);
  const [editing, setEditing] = useState(false);
  const [detailNotice, setDetailNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bookingDialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (activity || error) return;
    let cancelled = false;
    loadPersonalActivityAction().then((value) => {
      if (!cancelled) setActivity(value);
    }).catch(() => {
      if (!cancelled) setError("Unable to load your court activity. Try again.");
    });
    return () => { cancelled = true; };
  }, [activity, error]);

  async function cancel() {
    if (!selected || pending) return;
    setPending(true); setCancelError("");
    let cancelled = false;
    try {
      const result = await cancelOwnReservationAction(selected.id);
      if (!result.ok) { setCancelError(result.message); return; }
      cancelled = true;
      setConfirming(false);
      dialogRef.current?.close();
      setSelected(null);
      setSuccess("Reservation cancelled.");
    } catch {
      setCancelError("Unable to cancel this reservation. Try again.");
    } finally { setPending(false); }
    if (cancelled) {
      try { setActivity(await loadPersonalActivityAction()); }
      catch { setActivity(null); setError("Unable to load your court activity. Try again."); }
    }
  }

  async function refreshEditedReservation(notice: string) {
    setEditing(false);
    try {
      const refreshed = await loadPersonalActivityAction();
      setActivity(refreshed);
      const current = refreshed.upcoming.find((row) => row.id === selected?.id);
      setSelected(current ?? null);
      setDetailNotice(notice);
    } catch {
      setSelected(null);
      setActivity(null);
      setError("Unable to load your court activity. Try again.");
    }
  }

  if (!activity && !error) return <p role="status" className="text-sm text-muted-foreground">Loading your court activity…</p>;
  if (error) return <div role="alert" className="text-sm text-danger">{error} <button type="button" className="font-semibold underline" onClick={() => setError("")}>Retry</button></div>;
  if (!activity) return null;

  const list = (rows: CourtActivity[]) => <section aria-label="Upcoming" className="space-y-2">
    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Upcoming</h2>
    {rows.length ? <ul className="divide-y divide-border rounded-control border border-border bg-background">
      {rows.map((item) => <li key={`${item.kind}:${item.row.id}`}><button type="button" onClick={(event) => { returnFocusRef.current = event.currentTarget; setSuccess(""); setDetailNotice(""); setEditing(false);
        if (item.kind === "booking") setSelectedBooking(item.row); else setSelected(item.row); }}
        className="w-full p-3 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
        <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">{item.kind === "booking" ? "Booking" : "Reservation"}</span>
        <span className="block text-sm font-semibold text-primary">{item.row.location_name} · {item.row.court_name}</span>
        <span className="mt-1 block text-sm text-foreground">{dateLabel(item.row.booking_date)} · {timeLabel(item.row.starts_at_minute)}–{timeLabel(item.row.ends_at_minute)} · {item.row.ends_at_minute - item.row.starts_at_minute} min</span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">{item.kind === "booking" ? formatMoney(item.row.total_amount_minor, item.row.currency) : item.row.reason || "No reason recorded"}</span>
      </button></li>)}
    </ul> : <p className="text-sm text-muted-foreground">No upcoming bookings or reservations.</p>}
  </section>;

  return <>
    <p role="status" className="min-h-5 text-sm text-success">{success}</p>
    {list(sortedActivity(activity))}
    {selectedBooking && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={bookingDialogRef} active aria-labelledby={`${titleId}-booking`}
        onClose={() => { setSelectedBooking(null); returnFocusRef.current?.focus(); }}
        className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
        <h2 id={`${titleId}-booking`} className="font-heading text-lg font-semibold">Booking</h2>
        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Location</dt><dd>{selectedBooking.location_name}</dd>
          <dt className="text-muted-foreground">Court</dt><dd>{selectedBooking.court_name}</dd>
          <dt className="text-muted-foreground">Date</dt><dd>{dateLabel(selectedBooking.booking_date)}</dd>
          <dt className="text-muted-foreground">Time</dt><dd>{timeLabel(selectedBooking.starts_at_minute)}–{timeLabel(selectedBooking.ends_at_minute)}</dd>
          <dt className="text-muted-foreground">Duration</dt><dd>{selectedBooking.ends_at_minute - selectedBooking.starts_at_minute} min</dd>
          <dt className="col-span-2 mt-2 font-semibold">Contact</dt>
          <dt className="text-muted-foreground">Name</dt><dd>{selectedBooking.customer_name}</dd>
          <dt className="text-muted-foreground">Email</dt><dd>{selectedBooking.customer_email}</dd>
          <dt className="text-muted-foreground">Phone</dt><dd>{selectedBooking.customer_phone}</dd>
          <dt className="text-muted-foreground">Total</dt><dd>{formatMoney(selectedBooking.total_amount_minor, selectedBooking.currency)}</dd>
          <dt className="text-muted-foreground">Status</dt><dd>Confirmed</dd>
        </dl>
        <div className="mt-5 flex justify-end"><button type="button" onClick={(event) => event.currentTarget.closest("dialog")?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></div>
      </ModalDialog>, document.body)}
    {selected && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (pending) event.preventDefault(); }} onClose={() => { setSelected(null); returnFocusRef.current?.focus(); }}
        className={`fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 ${editing && !isReservationInProgress(selected, new Date()) ? "max-w-6xl" : "max-w-md"}`}>
        <h2 id={titleId} className="font-heading text-lg font-semibold">{editing ? "Edit reservation" : "Reservation details"}</h2>
        {editing ? <ReservationEditForm key={`${selected.id}:${selected.updated_at}`} reservation={selected}
          inProgress={isReservationInProgress(selected, new Date())} onCancel={() => setEditing(false)} onPendingChange={setPending}
          onSaved={async () => { await refreshEditedReservation(""); setSuccess("Reservation updated."); }}
          onStale={async () => { await refreshEditedReservation("This reservation has changed since you opened it. Review the current details before editing again."); }} /> : <>
        <p role={detailNotice ? "alert" : undefined} className="min-h-5 pt-2 text-sm text-danger">{detailNotice}</p>
        <ReservationDetails reservation={selected} />
        <div className="mt-5 flex justify-end gap-2">
          {staff && selected.status === "active" && activity.upcoming.some((row) => row.id === selected.id)
            && isReservationUpcoming(selected, new Date())
            && selected.created_by_user_id === userId && <>
            <button type="button" disabled={pending} onClick={() => { setDetailNotice(""); setEditing(true); }}
              className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit reservation</button>
            <button ref={cancelButtonRef} type="button" disabled={pending} onClick={() => { setCancelError(""); setConfirming(true); }}
              className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel reservation</button></>}
          <button type="button" disabled={pending} onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></div>
        </>}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && !!selected} title="Cancel reservation?"
      message={selected ? `${selected.location_name} · ${selected.court_name}\n${dateLabel(selected.booking_date)} · ${timeLabel(selected.starts_at_minute)}–${timeLabel(selected.ends_at_minute)}\nThis will free the court for other bookings.` : ""}
      confirmLabel="Cancel reservation" cancelLabel="Keep reservation" pending={pending} error={cancelError}
      onConfirm={cancel} onClose={() => { if (!pending) setConfirming(false); }} returnFocusRef={cancelButtonRef} />
  </>;
}
