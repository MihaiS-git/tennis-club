"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
import { ModalDialog } from "@/components/modal-dialog";
import { ReservationDetailsView } from "@/components/reservation-details";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { parseActivityQuery, type ActivitySearchParams } from "@/lib/bookings/activity-query";
import type { UpcomingActivity as Activity, UpcomingCourtActivity as CourtActivity } from "@/lib/bookings/activity-service";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { formatMoney } from "@/lib/pricing/money";
import { isReservationInProgress, isReservationUpcoming, type PersonalReservation } from "@/lib/reservations/personal";
import { BookingEditForm, type BookingEditActions } from "@/app/reservations/booking-edit-form";
import { cancelOwnReservationAction, loadPersonalActivityAction, loadOwnBookingEditDayAction, quoteOwnBookingAction, rescheduleOwnBookingAction } from "./actions";
import { ActivityControls } from "../activity-controls";
import { ActivityTable } from "../activity-table";
import { ActivityPagination } from "../activity-pagination";
import { CustomerBookingCancellation } from "./customer-booking-cancellation";
import { ReservationEditForm } from "./reservation-edit-form";

const ownBookingActions: BookingEditActions = { load: loadOwnBookingEditDayAction, quote: quoteOwnBookingAction, save: rescheduleOwnBookingAction };

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
  return <ReservationDetailsView reservation={selected}>
    <dt className="text-muted-foreground">Created by</dt><dd>{selected.created_by_user_id ? selected.creator_name || "You" : "Not recorded"}</dd>
    {selected.status === "cancelled" && <>
      <dt className="text-muted-foreground">Cancelled at</dt><dd>{selected.cancelled_at ? timestampLabel(selected.cancelled_at, selected.location_timezone) : "Not recorded"}</dd>
      <dt className="text-muted-foreground">Cancelled by</dt><dd>{selected.cancelled_by_name || "Club staff"}</dd>
    </>}
  </ReservationDetailsView>;
}

export function PersonalActivity({ staff, userId, initialActivity, initialError, listQuery }: {
  staff: boolean; userId?: string; initialActivity: Activity | null; initialError: string; listQuery?: ActivitySearchParams;
}) {
  const [activity, setActivity] = useState(initialActivity);
  const [error, setError] = useState(initialError);
  const [serverSnapshot, setServerSnapshot] = useState({ initialActivity, initialError });
  // Next.js preserves this component across navigation. Adopt revalidated server reads
  // without remounting its dialogs or discarding their pending/submitted state.
  if (serverSnapshot.initialActivity !== initialActivity || serverSnapshot.initialError !== initialError) {
    setServerSnapshot({ initialActivity, initialError });
    setActivity(initialActivity);
    setError(initialError);
  }
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
  const returnFocusRef = useRef<HTMLTableRowElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (activity || error) return;
    let cancelled = false;
    loadPersonalActivityAction(listQuery).then((value) => {
      if (!cancelled) setActivity(value);
    }).catch(() => {
      if (!cancelled) setError("Unable to load your court activity. Try again.");
    });
    return () => { cancelled = true; };
  }, [activity, error, listQuery]);

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
      try { setActivity(await loadPersonalActivityAction(listQuery)); }
      catch { setActivity(null); setError("Unable to load your court activity. Try again."); }
    }
  }

  async function refreshCancelledBooking() {
    bookingDialogRef.current?.close();
    setSelectedBooking(null);
    setSuccess("Booking cancelled.");
    try { setActivity(await loadPersonalActivityAction(listQuery)); }
    catch { setActivity(null); setError("Unable to load your court activity. Try again."); }
  }

  async function refreshEditedReservation(notice: string) {
    setEditing(false);
    try {
      const refreshed = await loadPersonalActivityAction(listQuery);
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

  function openDetails(item: CourtActivity, row: HTMLTableRowElement) {
    returnFocusRef.current = row;
    setSuccess(""); setDetailNotice(""); setEditing(false);
    if (item.kind === "booking") setSelectedBooking(item.row); else setSelected(item.row);
  }

  const list = (rows: CourtActivity[]) => <section aria-label="Upcoming" className="space-y-2">
    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Upcoming</h2>
    {rows.length ? <ActivityTable scope="upcoming" query={query} staff={staff}>
      {rows.map((item) => <tr key={`${item.kind}:${item.row.id}`} tabIndex={0}
        aria-label={`Details for ${item.row.court_name} on ${dateLabel(item.row.booking_date)}`}
        onClick={(event) => openDetails(item, event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(item, event.currentTarget); }
        }}
        className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
        {staff && <td className="whitespace-nowrap px-3 py-3">{item.kind === "booking" ? "Booking" : "Reservation"}</td>}
        <td className="px-3 py-3 font-semibold text-primary">{item.row.location_name}</td>
        <td className="px-3 py-3">{item.row.court_name}</td>
        <td className="whitespace-nowrap px-3 py-3">{dateLabel(item.row.booking_date)}</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{timeLabel(item.row.starts_at_minute)}–{timeLabel(item.row.ends_at_minute)}</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{item.row.ends_at_minute - item.row.starts_at_minute} min</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{item.kind === "booking" ? formatMoney(item.row.total_amount_minor, item.row.currency) : "—"}</td>
      </tr>)}
    </ActivityTable> : <p className="text-sm text-muted-foreground">No upcoming bookings or reservations match your filters.</p>}
  </section>;

  const query = parseActivityQuery(listQuery ?? {}, "upcoming", staff);
  return <>
    {activity.locations && activity.courts && <ActivityControls staff={staff} scope="upcoming" query={query}
      options={{ locations: activity.locations, courts: activity.courts }} />}
    <p role="status" className="min-h-5 text-sm text-success">{success}</p>
    {list(activity.ordered ?? [...activity.bookings.map((row): CourtActivity => ({ kind: "booking", row })), ...activity.upcoming.map((row): CourtActivity => ({ kind: "reservation", row }))])}
    {activity.hasNext !== undefined && <ActivityPagination scope="upcoming" query={query}
      hasNext={activity.hasNext} empty={!activity.bookings.length && !activity.upcoming.length} />}
    {selectedBooking && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={bookingDialogRef} active aria-labelledby={`${titleId}-booking`}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
        onClose={() => { setSelectedBooking(null); returnFocusRef.current?.focus(); }}
        className={`fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 ${editing ? "max-w-6xl" : "max-w-md"}`}>
        <DialogHeader titleId={`${titleId}-booking`} title={editing ? "Edit booking" : "Booking"} status={editing ? undefined : "Confirmed"} disabled={pending} onClose={() => bookingDialogRef.current?.close()} />
        {editing ? <BookingEditForm booking={selectedBooking}
          actions={ownBookingActions} onCancel={() => setEditing(false)} onPendingChange={setPending}
          onSaved={async () => {
            setEditing(false);
            setSuccess("Booking updated.");
            try {
              const refreshed = await loadPersonalActivityAction(listQuery);
              setActivity(refreshed);
              setSelectedBooking(refreshed.bookings.find((row) => row.id === selectedBooking.id) ?? null);
            } catch {
              setSelectedBooking(null); setActivity(null);
              setError("Unable to load your court activity. Try again.");
            }
          }} /> : <>
        <BookingDetails booking={selectedBooking} />
        <DialogFooter>
          <CustomerBookingCancellation booking={selectedBooking} staff={staff}
            onCancelled={refreshCancelledBooking} onPendingChange={setPending} onEdit={() => setEditing(true)} />
          <button type="button" disabled={pending} onClick={(event) => event.currentTarget.closest("dialog")?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
        </>}
      </ModalDialog>, document.body)}
    {selected && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (pending) event.preventDefault(); }} onClose={() => { setSelected(null); returnFocusRef.current?.focus(); }}
        className={`fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 ${editing && !isReservationInProgress(selected, new Date()) ? "max-w-6xl" : "max-w-md"}`}>
        <DialogHeader titleId={titleId} title={editing ? "Edit reservation" : "Reservation details"} status={editing ? undefined : selected.status === "cancelled" ? "Cancelled" : "Active"} disabled={pending} onClose={() => dialogRef.current?.close()} />
        {editing ? <ReservationEditForm key={`${selected.id}:${selected.updated_at}`} reservation={selected}
          inProgress={isReservationInProgress(selected, new Date())} onCancel={() => setEditing(false)} onPendingChange={setPending}
          onSaved={async () => { await refreshEditedReservation(""); setSuccess("Reservation updated."); }}
          onStale={async () => { await refreshEditedReservation("This reservation has changed since you opened it. Review the current details before editing again."); }} /> : <>
        <p role={detailNotice ? "alert" : undefined} className="min-h-5 pt-2 text-sm text-danger">{detailNotice}</p>
        <ReservationDetails reservation={selected} />
        <DialogFooter>
          {staff && selected.status === "active" && activity.upcoming.some((row) => row.id === selected.id)
            && isReservationUpcoming(selected, new Date())
            && selected.created_by_user_id === userId && <>
            <button type="button" disabled={pending} onClick={() => { setDetailNotice(""); setEditing(true); }}
              className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit reservation</button>
            <button ref={cancelButtonRef} type="button" disabled={pending} onClick={() => { setCancelError(""); setConfirming(true); }}
              className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel reservation</button></>}
          <button type="button" disabled={pending} onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
        </>}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && !!selected} title="Cancel reservation?"
      message={selected ? `${selected.location_name} · ${selected.court_name}\n${dateLabel(selected.booking_date)} · ${timeLabel(selected.starts_at_minute)}–${timeLabel(selected.ends_at_minute)}\nThis will free the court for other bookings.` : ""}
      confirmLabel="Cancel reservation" cancelLabel="Keep reservation" pending={pending} error={cancelError}
      onConfirm={cancel} onClose={() => { if (!pending) setConfirming(false); }} returnFocusRef={cancelButtonRef} />
  </>;
}
