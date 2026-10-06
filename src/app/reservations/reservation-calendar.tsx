"use client";

import { useId, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { BookingEditForm } from "./booking-edit-form";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
import { ModalDialog } from "@/components/modal-dialog";
import { ReservationEditForm } from "@/components/reservation-edit-form";
import { ReservationDetailsView, reservationDateLabel } from "@/components/reservation-details";
import { formatMoney } from "@/lib/pricing/money";
import { ReservationTimetable, type ReservationTimetableDay } from "@/components/reservation-timetable";
import { reservationEditInput, reservationEditSchema, selectReservationCell, type ReservationCell, type ReservationSelection } from "@/lib/reservations/domain";
import { isReservationBeforeStart, isReservationInProgress, isReservationUpcoming } from "@/lib/reservations/personal";
import type { AdminOperationalOccupancy, AdminReservation, InternalLocation } from "@/lib/reservations/service";
import { cancelAdminCustomerBookingAction, cancelAdminReservationAction, editAdminReservationAction, loadAdminReservationEditDayAction, reserveCourtAction } from "./actions";

export function ReservationCalendar({ day, date, location, occupancy = [], adminOccupancy = [] }: {
  day: ReservationTimetableDay;
  date: string; location: InternalLocation; adminOccupancy?: AdminOperationalOccupancy[];
  occupancy?: { court_id: string; starts_at_minute: number; ends_at_minute: number }[];
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<ReservationSelection | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [selectedOccupancyId, setSelectedOccupancyId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [updatedReservation, setUpdatedReservation] = useState<AdminReservation | null>(null);
  const [refundPayment, setRefundPayment] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const selectedOccupancy = adminOccupancy.find((item) => item.id === selectedOccupancyId);
  const selectedGenericOccupancy = !adminOccupancy.length
    ? occupancy.find((item) => `${item.court_id}:${item.starts_at_minute}` === selectedOccupancyId) : undefined;
  const selectedReservation = selectedOccupancy?.kind === "reservation"
    ? updatedReservation?.id === selectedOccupancy.id ? updatedReservation : selectedOccupancy : null;
  const selectedBooking = selectedOccupancy?.kind === "booking" ? selectedOccupancy : null;
  const selectedCourtName = location.courts.find((court) => court.id === (selectedOccupancy ?? selectedGenericOccupancy)?.court_id)?.name ?? "Court";
  const editInProgress = selectedReservation ? isReservationInProgress({ ...selectedReservation,
    location_timezone: location.timezone }, new Date()) : false;
  const selectedCourt = day.courts.find((item) => item.court.id === selection?.courtId)?.court;
  function choose(courtId: string, cells: ReservationCell[], row: number) {
    setSelection((current) => selectReservationCell({ courtId, times: day.times, cells }, current, row));
    setMessage(""); setSuccess(false);
  }
  function submit() {
    if (!selection || !reason.trim()) { setMessage("Enter a reason."); return; }
    startTransition(async () => {
      const result = await reserveCourtAction({ locationId: location.id, courtId: selection.courtId, date,
        startMinute: selection.startMinute, endMinute: selection.endMinute, reason });
      if (result.ok) { setSelection(null); setReason(""); setMessage("Court reserved."); setSuccess(true); }
      else { setMessage(result.message); setSuccess(false); }
    });
  }
  async function cancelReservation() {
    if (!selectedReservation || cancelPending || !isReservationBeforeStart({ ...selectedReservation, location_timezone: location.timezone }, new Date())) return;
    setCancelPending(true);
    setCancelError("");
    try {
      const result = await cancelAdminReservationAction(selectedReservation.id);
      if (!result.ok) { setCancelError(result.message); return; }
      setConfirming(false);
      dialogRef.current?.close();
      setSelectedOccupancyId(null);
      setSelection(null);
      setMessage("Reservation cancelled.");
      setSuccess(true);
      router.refresh();
    } catch {
      setCancelError("Unable to cancel this reservation. Try again.");
    } finally { setCancelPending(false); }
  }
  async function cancelBooking() {
    if (!selectedBooking || cancelPending || !isReservationBeforeStart({ ...selectedBooking, location_timezone: location.timezone }, new Date())) return;
    setCancelPending(true);
    setCancelError("");
    try {
      const result = await cancelAdminCustomerBookingAction({ id: selectedBooking.id, refund: selectedBooking.stripe_refund_available ? refundPayment : null });
      if (!result.ok) { setCancelError(result.message); return; }
      setConfirming(false);
      dialogRef.current?.close();
      setSelectedOccupancyId(null);
      setSelection(null);
      setMessage(cancelledBookingMessage(result.refundStatus));
      setSuccess(true);
      router.refresh();
    } catch {
      setCancelError("Unable to cancel this booking. Try again.");
    } finally { setCancelPending(false); }
  }
  async function openEdit() {
    if (!selectedReservation) return;
    setEditing(true); setEditToken(null); setEditError("");
    try {
      const result = await loadAdminReservationEditDayAction(selectedReservation.id, selectedReservation.booking_date);
      setEditToken(result.reservation.updated_at);
    } catch { setEditError("Unable to load the current reservation. Try again."); }
  }
  return <>
    {day.times.length === 0 ? <p className="mt-5 rounded-card border border-border bg-surface p-5 text-muted-foreground">{location.name} is closed on {date}.</p>
      : <ReservationTimetable day={day} date={date} timezone={location.timezone} selection={selection} onChoose={choose} disabled={pending}
          occupiedIntervals={adminOccupancy.length ? adminOccupancy.map((item) => ({ id: item.id, courtId: item.court_id,
            startsAtMinute: item.starts_at_minute, endsAtMinute: item.ends_at_minute, kind: item.kind,
            label: item.kind === "booking" ? `Booking · ${item.customer_name}` : `Reservation · ${item.creator_name || "Unknown creator"}` }))
            : occupancy.map((item) => ({ id: `${item.court_id}:${item.starts_at_minute}`, courtId: item.court_id,
              startsAtMinute: item.starts_at_minute, endsAtMinute: item.ends_at_minute, label: "Booked" }))}
          onOccupiedClick={(id) => {
            returnFocusRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
            setEditing(false);
            setUpdatedReservation(null);
            setSelectedOccupancyId(id);
          }} />}
    {selection && selectedCourt && <section aria-label="Selected reservation" className="mt-4 rounded-card border border-border bg-surface p-4">
      <h2 className="font-heading text-lg font-semibold text-primary">Reserve court</h2>
      <p className="mt-1 text-sm text-foreground">{location.name} · {selectedCourt.name} · {date} · {minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.endMinute - selection.startMinute} min</p>
      <label className="mt-3 flex max-w-xl flex-col gap-1 text-sm font-semibold text-primary">Reason
        <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={255} required
          className="min-h-10 rounded-control border border-border-strong bg-background px-3 font-normal text-foreground" />
      </label>
      <div className="mt-3 flex gap-2"><button type="button" disabled={pending || !reason.trim()} onClick={submit}
        className="min-h-10 rounded-control bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{pending ? "Reserving…" : "Reserve court"}</button>
        <button type="button" onClick={() => { setSelection(null); setMessage(""); }} className="min-h-10 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary">Clear selection</button></div>
    </section>}
    <p role={success ? "status" : "alert"} className={`mt-2 min-h-5 text-sm ${success ? "text-success" : "text-danger"}`}>{message}</p>
    {(selectedOccupancy || selectedGenericOccupancy) && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (cancelPending) event.preventDefault(); }}
        onClose={() => { setSelectedOccupancyId(null); setEditing(false); setEditToken(null);
          setUpdatedReservation(null); setConfirming(false); returnFocusRef.current?.focus(); }}
        className={`fixed inset-0 m-auto w-[calc(100%-2rem)] rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 ${editing && !editInProgress ? "max-w-6xl" : "max-w-md"}`}>
        <DialogHeader titleId={titleId} title={selectedGenericOccupancy ? "Occupied court details" : selectedBooking ? editing ? "Edit booking" : "Booking details" : editing ? "Edit reservation" : "Reservation details"} status={editing || selectedGenericOccupancy ? undefined : selectedBooking ? "Confirmed" : "Active"} disabled={cancelPending} onClose={() => dialogRef.current?.close()} />
        {selectedBooking ? <>
          <BookingDetails booking={{ ...selectedBooking, location_name: location.name,
            location_timezone: location.timezone, court_name: selectedCourtName }} />
          {editing ? <BookingEditForm booking={selectedBooking} location={location}
            onCancel={() => setEditing(false)} onPendingChange={setCancelPending}
            onSaved={async () => { dialogRef.current?.close(); setSelectedOccupancyId(null); setEditing(false);
              setSelection(null); setMessage("Booking rescheduled."); setSuccess(true); router.refresh(); }} />
            : <DialogFooter>
            {isReservationBeforeStart({ ...selectedBooking, location_timezone: location.timezone }, new Date())
              && <button type="button" disabled={cancelPending} onClick={() => setEditing(true)}
                className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit booking</button>}
            {isReservationBeforeStart({ ...selectedBooking, location_timezone: location.timezone }, new Date()) && <button ref={cancelButtonRef} type="button" disabled={cancelPending}
              onClick={() => { setCancelError(""); setRefundPayment(false); setConfirming(true); }}
              className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel booking</button>}
            <button type="button" disabled={cancelPending} onClick={() => dialogRef.current?.close()}
              className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button>
          </DialogFooter>}
        </> : selectedReservation && editing && !editToken ? <div className="mt-4 text-sm" role={editError ? "alert" : "status"}>
          {editError || "Loading reservation…"}
          {editError && <button type="button" className="ml-2 font-semibold underline" onClick={openEdit}>Retry</button>}
        </div> : selectedReservation && editing ? <ReservationEditForm key={selectedReservation.id} reservation={{ ...selectedReservation,
          location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }}
          inProgress={editInProgress} loadAvailability={loadAdminReservationEditDayAction}
          onCancel={() => setEditing(false)}
          onSave={async ({ date: targetDate, selection: targetSelection, reason: targetReason, inProgress }) => {
            if (!editToken) return { ok: false, message: "Reload this reservation before saving." };
            const input = reservationEditInput({ id: selectedReservation.id, expectedUpdatedAt: editToken,
              courtId: selectedReservation.court_id, bookingDate: selectedReservation.booking_date,
              startMinute: selectedReservation.starts_at_minute, endMinute: selectedReservation.ends_at_minute,
              date: targetDate, selection: targetSelection, reason: targetReason, reasonOnly: inProgress });
            const parsed = reservationEditSchema.safeParse(input);
            if (!parsed.success) {
              const fieldErrors: Record<string, string> = {};
              for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
              return { ok: false, message: "Check the highlighted fields.", fieldErrors };
            }
            const result = await editAdminReservationAction(parsed.data);
            if (result.ok) setUpdatedReservation({ ...selectedReservation, ...result.reservation });
            return result;
          }}
          onSaved={async () => { setEditing(false); setEditToken(null); setMessage("Reservation updated.");
            setSuccess(true); router.refresh(); }}
          onStale={async () => { setEditing(false); setEditToken(null); setUpdatedReservation(null);
            setMessage("This reservation has changed since you opened it. Refresh and try again.");
            setSuccess(false); router.refresh(); }} /> : selectedReservation ? <>
        <ReservationDetailsView reservation={{ ...selectedReservation, location_name: location.name,
            location_timezone: location.timezone,
            court_name: selectedCourtName }}>
          <dt className="text-muted-foreground">Created by</dt><dd>{selectedReservation.creator_name || "Unknown creator"}</dd>
        </ReservationDetailsView>
        <DialogFooter>
          {isReservationUpcoming({ ...selectedReservation, status: "active", location_timezone: location.timezone }, new Date())
            && <button type="button" disabled={cancelPending} onClick={openEdit}
              className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit reservation</button>}
          {isReservationBeforeStart({ ...selectedReservation, location_timezone: location.timezone }, new Date()) && <button ref={cancelButtonRef} type="button" disabled={cancelPending}
            onClick={() => { setCancelError(""); setRefundPayment(false); setConfirming(true); }}
            className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel reservation</button>}
          <button type="button" disabled={cancelPending} onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
        </> : selectedGenericOccupancy ? <>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Location</dt><dd>{location.name}</dd>
            <dt className="text-muted-foreground">Court</dt><dd>{selectedCourtName}</dd>
            <dt className="text-muted-foreground">Date</dt><dd>{reservationDateLabel(date)}</dd>
            <dt className="text-muted-foreground">Time</dt><dd>{minuteToTime(selectedGenericOccupancy.starts_at_minute)}–{minuteToTime(selectedGenericOccupancy.ends_at_minute)} ({location.timezone})</dd>
          </dl>
          <DialogFooter><button type="button" onClick={() => dialogRef.current?.close()}
            className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
        </> : null}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && !!selectedOccupancy} title={selectedBooking ? "Cancel booking?" : "Cancel reservation?"}
      message={selectedBooking
        ? `Customer\n${selectedBooking.customer_name}\n\n${location.name} · ${selectedCourtName}\n${reservationDateLabel(selectedBooking.booking_date)} · ${minuteToTime(selectedBooking.starts_at_minute)}–${minuteToTime(selectedBooking.ends_at_minute)}\n\nTotal\n${formatMoney(selectedBooking.total_amount_minor, selectedBooking.currency)} · ${selectedBooking.currency}\n\nThis will cancel the booking and free the court.`
        : selectedReservation ? `${location.name} · ${selectedCourtName}\n${reservationDateLabel(selectedReservation.booking_date)} · ${minuteToTime(selectedReservation.starts_at_minute)}–${minuteToTime(selectedReservation.ends_at_minute)}\nCreated by\n${selectedReservation.creator_name || "Unknown creator"}\n\nThis will free the court for other bookings and reservations.` : ""}
      confirmLabel={selectedBooking ? "Cancel booking" : "Cancel reservation"}
      cancelLabel={selectedBooking ? "Keep booking" : "Keep reservation"} pending={cancelPending} error={cancelError}
      onConfirm={selectedBooking ? cancelBooking : cancelReservation}
      onClose={() => { if (!cancelPending) setConfirming(false); }} returnFocusRef={cancelButtonRef}>
      {selectedBooking?.stripe_refund_available && <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={refundPayment} disabled={cancelPending}
          onChange={(event) => setRefundPayment(event.target.checked)} />Refund full payment
      </label>}
    </ConfirmationDialog>
  </>;
}
