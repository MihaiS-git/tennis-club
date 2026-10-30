"use client";


import { useStaffCalendar } from "@/components/staff-calendar-context";
import Link from "next/link";
import { AdminBookingEdit } from "@/app/admin/bookings/admin-booking-editor";
import { bookingType } from "@/lib/bookings/booking-type";
import { toast } from "sonner";

import { useId, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { cancelOwnReservationAction, editOwnReservationAction, loadReservationEditDayAction,
  loadOwnBookingEditDayAction, quoteOwnBookingAction, rescheduleOwnBookingAction } from "@/app/my-activity/bookings/actions";
import { CustomerBookingCancellation } from "@/app/my-activity/bookings/customer-booking-cancellation";
import { localStartInstant } from "@/lib/courts/local-time";
import { BookingEditForm, type BookingEditActions } from "@/components/booking-edit-form";
import { Button } from "@/components/button";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DetailSection, DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
import { ModalDialog } from "@/components/modal-dialog";
import { ReservationEditForm } from "@/components/reservation-edit-form";
import { ReservationDetailsView, ReservationScheduleFieldsView, reservationDateLabel } from "@/components/reservation-details";
import type { TimelineCellState } from "@/components/court-timeline-grid";
import { ReservationTimetable, type ReservationTimetableDay } from "@/components/reservation-timetable";
import { reservationEditInput, reservationEditSchema, selectReservationCell, type ReservationSelection } from "@/lib/reservations/domain";
import { isReservationBeforeStart, isReservationInProgress, isReservationUpcoming } from "@/lib/reservations/personal";
import type { AdminOperationalOccupancy, AdminReservation, InternalLocation } from "@/lib/reservations/service";
import { paymentProviderLabels } from "@/lib/payments/admin-query";
import type { LatestFinancialStatus } from "@/lib/payments/latest-financial-status";
import { adminBookingLinkFrom, adminReservationLinkFrom, coachLessonLinkFrom, coachReservationLinkFrom } from "@/lib/bookings/admin-query";
import { CoachLessonCancellation } from "@/app/coach/bookings/lessons/[bookingId]/lesson-cancellation";
import { CoachLessonReschedule } from "@/app/coach/bookings/lessons/[bookingId]/lesson-reschedule";
import { AdminBookingCancellation } from "./admin-booking-cancellation";
import { cancelAdminReservationAction, editAdminReservationAction, loadAdminReservationEditDayAction, reserveCourtAction } from "./actions";

const ownBookingActions: BookingEditActions = { load: loadOwnBookingEditDayAction, quote: quoteOwnBookingAction, save: rescheduleOwnBookingAction };

function financialStatusLabel(summary: LatestFinancialStatus) {
  const provider = summary.provider ? ` (${paymentProviderLabels[summary.provider]})` : "";
  if (summary.operation === "payment" && summary.status === "due") return "Payment due at club";
  return `${summary.operation === "payment" ? "Payment" : "Refund"} ${summary.status}${provider}`;
}

export function ReservationCalendar({ day, date, location, occupancy = [], adminOccupancy = [], canManage = false, actorUserId }: {
  day: ReservationTimetableDay;
  date: string; location: InternalLocation; adminOccupancy?: AdminOperationalOccupancy[];
  canManage?: boolean;
  actorUserId?: string;
  occupancy?: { court_id: string; starts_at_minute: number; ends_at_minute: number }[];
}) {
  const router = useRouter();
  const calendar = useStaffCalendar();
  const rescheduling = calendar?.active;
  const shownDay = rescheduling && calendar.day ? calendar.day : day;
  const shownDate = rescheduling ? calendar.target?.date ?? date : date;
  const [selection, setSelection] = useState<ReservationSelection | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [selectedOccupancyId, setSelectedOccupancyId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [updatedReservation, setUpdatedReservation] = useState<AdminReservation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [browsingDay, setBrowsingDay] = useState(`${location.id}:${date}`);
  if (browsingDay !== `${location.id}:${date}`) {
    setBrowsingDay(`${location.id}:${date}`); setSelection(null); setSelectedOccupancyId(null);
    setEditing(false); setUpdatedReservation(null); setConfirming(false);
  }
  const selectedOccupancy = adminOccupancy.find((item) => item.id === selectedOccupancyId);
  const selectedGenericOccupancy = !adminOccupancy.length
    ? occupancy.find((item) => `${item.court_id}:${item.starts_at_minute}` === selectedOccupancyId)
    : selectedOccupancy?.kind === "occupied" ? selectedOccupancy : undefined;
  const selectedHold = selectedOccupancy?.kind === "hold" ? selectedOccupancy : null;
  const selectedModification = selectedOccupancy?.kind === "modification" ? selectedOccupancy : null;
  const selectedLesson = selectedOccupancy?.kind === "lesson" ? selectedOccupancy : null;
  const selectedReservation = selectedOccupancy?.kind === "reservation"
    ? updatedReservation?.id === selectedOccupancy.id ? updatedReservation : selectedOccupancy : null;
  const selectedBooking = selectedOccupancy?.kind === "booking" ? selectedOccupancy : null;
  const ownsReservation = !!actorUserId && selectedReservation?.created_by_user_id === actorUserId;
  const ownsBooking = !!actorUserId && selectedBooking?.account_user_id === actorUserId;
  const canEditReservation = !!selectedReservation && (canManage || ownsReservation)
    && isReservationUpcoming({ ...selectedReservation, status: "active", location_timezone: location.timezone }, new Date());
  const loadReservationEdit = canManage ? loadAdminReservationEditDayAction : loadReservationEditDayAction;
  const canCancelReservation = !!selectedReservation && (canManage
    ? isReservationBeforeStart({ ...selectedReservation, location_timezone: location.timezone }, new Date())
    : ownsReservation
      && isReservationUpcoming({ ...selectedReservation, status: "active", location_timezone: location.timezone }, new Date()));
  const selectedCourtName = location.courts.find((court) => court.id === (selectedOccupancy ?? selectedGenericOccupancy)?.court_id)?.name ?? "Court";
  const editInProgress = selectedReservation ? isReservationInProgress({ ...selectedReservation,
    location_timezone: location.timezone }, new Date()) : false;
  const selectedCourt = day.courts.find((item) => item.court.id === selection?.courtId)?.court;
  function choose(courtId: string, cells: TimelineCellState[], row: number) {
    if (rescheduling) { calendar.choose(courtId, shownDay.times[row]); return; }
    setSelection((current) => selectReservationCell({ courtId, times: day.times, cells: cells.map(cell => cell === "unavailable" ? "closed" : cell) }, current, row));
  }
  function submit() {
    if (pending || !selection) return;
    if (!reason.trim()) { setFieldErrors({ reason: "Enter a reason." }); return; }
    setFieldErrors({});
    startTransition(async () => {
      const notification = toast.loading("Reserving court…");
      try {
        const result = await reserveCourtAction({ locationId: location.id, courtId: selection.courtId, date,
          startMinute: selection.startMinute, endMinute: selection.endMinute, reason });
        if (result.ok) { setSelection(null); setReason(""); toast.success("Court reserved.", { id: notification }); }
        else toast.error(result.message, { id: notification });
      } catch { toast.error("Unable to reserve this court. Try again.", { id: notification }); }
    });
  }
  async function cancelReservation() {
    if (!canCancelReservation || !selectedReservation || cancelPending) return;
    const notification = toast.loading("Cancelling…");
    setCancelPending(true);
    try {
      const result = await (canManage ? cancelAdminReservationAction : cancelOwnReservationAction)(selectedReservation.id);
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      setConfirming(false);
      dialogRef.current?.close();
      setSelectedOccupancyId(null);
      setSelection(null);
      toast.success("Reservation cancelled.", { id: notification });
      router.refresh();
    } catch {
      toast.error("Unable to cancel this reservation. Try again.", { id: notification });
    } finally { setCancelPending(false); }
  }
  async function openEdit() {
    if (!canEditReservation || !selectedReservation) return;
    setEditing(true); setEditToken(null); setEditError("");
    const notification = toast.loading("Loading reservation…");
    try {
      const result = await loadReservationEdit(selectedReservation.id, selectedReservation.booking_date);
      toast.dismiss(notification);
      if (!canManage) setUpdatedReservation({ ...selectedReservation, ...result.reservation });
      setEditToken(result.reservation.updated_at);
    } catch { setEditError("Unable to load the current reservation. Try again."); toast.error("Unable to load the current reservation. Try again.", { id: notification, action: { label: "Retry", onClick: () => void openEdit() } }); }
  }
  return <>
    {calendar?.toolbar}
    {shownDay.times.length === 0 ? <p className="mt-5 rounded-card border border-border bg-surface p-5 text-muted-foreground">{location.name} is closed on {date}.</p>
      : <ReservationTimetable day={shownDay} date={shownDate} timezone={location.timezone} selection={rescheduling ? calendar.selection : selection} onChoose={choose} disabled={pending || rescheduling && calendar.pending}
          fixedDuration={rescheduling ? calendar.duration || undefined : undefined} original={rescheduling ? calendar.original : undefined}
          occupiedIntervals={rescheduling ? [] : adminOccupancy.length ? adminOccupancy.map((item) => {
            // The signed-in Coach's own lessons (also for an Admin who coaches) are labelled with their booked program.
            const ownLesson = item.kind === "lesson" || item.kind === "booking" && bookingType(item) === "coaching" && !!actorUserId && item.coach_user_id === actorUserId;
            const program = (item.kind === "lesson" || item.kind === "booking") && item.coaching_program_name || "Coaching";
            return { id: item.id, courtId: item.court_id,
            startsAtMinute: item.starts_at_minute, endsAtMinute: item.ends_at_minute, kind: item.kind === "reservation" ? item.kind : ownLesson ? "lesson" as const : "booking" as const,
            includesCoaching: item.kind === "lesson" || item.kind === "booking" && bookingType(item) === "coaching",
            blockLabel: ownLesson ? program : undefined,
            label: item.kind === "hold" ? "Temporary checkout hold" : item.kind === "modification" ? "Modification in progress" : item.kind === "occupied" ? "Booked"
              : ownLesson && (item.kind === "lesson" || item.kind === "booking") ? `Your lesson · ${program} · ${item.customer_name}`
              : item.kind === "booking" ? `${bookingType(item) === "coaching" ? "Coaching" : "Booking"} · ${item.customer_name}` : `Reservation · ${item.creator_name || "Unknown creator"}` }; })
            : occupancy.map((item) => ({ id: `${item.court_id}:${item.starts_at_minute}`, courtId: item.court_id,
              startsAtMinute: item.starts_at_minute, endsAtMinute: item.ends_at_minute, label: "Booked" }))}
          onOccupiedClick={(id) => {
            returnFocusRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
            setEditing(false);
            setUpdatedReservation(null);
            setSelectedOccupancyId(id);
          }} />}
    {!rescheduling && selection && selectedCourt && <section aria-label="Selected reservation" className="mt-4 rounded-card border border-border bg-surface p-4">
      <h2 className="font-heading text-lg font-semibold text-primary">Reserve court</h2>
      <p className="mt-1 text-sm text-foreground">{location.name} · {selectedCourt.name} · {date} · {minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.endMinute - selection.startMinute} min</p>
      <label className="mt-3 flex max-w-xl flex-col gap-1 text-sm font-semibold text-primary">Reason
        <input value={reason} disabled={pending} aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={`${titleId}-reason-error`} onChange={(event) => { setReason(event.target.value); setFieldErrors({}); }} maxLength={255} required
          className="min-h-10 rounded-control border border-border-strong bg-background px-3 font-normal text-foreground" />
        {fieldErrors.reason && <p id={`${titleId}-reason-error`} role="alert" className="text-sm font-normal text-danger">{fieldErrors.reason}</p>}
      </label>
      <div className="mt-3 flex gap-2"><Button type="button" fullWidth={false} disabled={pending || !reason.trim()} onClick={submit}>{pending ? "Reserving…" : "Reserve court"}</Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => { setSelection(null); }}>Clear selection</Button></div>
    </section>}
    {(selectedOccupancy || selectedGenericOccupancy) && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (cancelPending) event.preventDefault(); }}
        onClose={() => { setSelectedOccupancyId(null); setEditing(false); setEditToken(null);
          if (dialogRef.current?.querySelector("[data-booking-modification]")) router.refresh();
          setUpdatedReservation(null); setConfirming(false); returnFocusRef.current?.focus(); }}
        className={`fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] overflow-y-auto w-[calc(100%-2rem)] rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 has-[[data-booking-modification]]:max-w-lg ${editing && !editInProgress ? "max-w-6xl" : "max-w-md"}`}>
        <DialogHeader titleId={titleId} title={selectedHold ? "Temporary checkout hold" : selectedModification ? "Modification in progress" : selectedGenericOccupancy ? "Occupied court details" : selectedLesson ? "Lesson details" : selectedBooking ? editing ? "Edit booking" : "Booking details" : editing ? "Edit reservation" : "Reservation details"} status={selectedHold ? "Payment pending" : selectedModification ? "Temporary" : editing || selectedGenericOccupancy ? undefined : selectedBooking || selectedLesson ? "Confirmed" : "Active"} disabled={cancelPending} onClose={() => dialogRef.current?.close()} />
        {selectedHold ? <>
          <p className="text-sm">This temporary checkout allocation is awaiting payment. No booking has been confirmed.</p>
          <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={{ ...selectedHold,
            location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }} /></DetailSection>
          <DetailSection title="Checkout">
            <dt>Deadline</dt><dd>{new Date(selectedHold.hold_expires_at).toLocaleString("en-GB", { timeZone: location.timezone })} ({location.timezone})</dd>
            <dt>Customer</dt><dd>{selectedHold.customer_name} · {selectedHold.customer_email}</dd>
          </DetailSection>
          <p className="text-sm">After the deadline, server reconciliation checks Stripe and releases unpaid holds. An unresolved payment keeps the court protected.</p>
          <Link className="mt-4 block text-sm text-primary underline" href={`/admin/payments/transactions?q=${selectedHold.id}`}>Review checkout payment</Link>
          <DialogFooter><Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>Close</Button></DialogFooter>
        </> : selectedModification ? <>
          <p className="text-sm">A customer is changing an existing booking to this time. The court is held temporarily until the change completes, fails or is cancelled. This is not a confirmed booking.</p>
          <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={{ ...selectedModification,
            location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }} /></DetailSection>
          <DetailSection title="Change">
            <dt>Held until</dt><dd>{new Date(selectedModification.hold_expires_at).toLocaleString("en-GB", { timeZone: location.timezone })} ({location.timezone})</dd>
            <dt>Customer</dt><dd>{selectedModification.customer_name} · {selectedModification.customer_email}</dd>
          </DetailSection>
          {canManage && <Link href={adminBookingLinkFrom(selectedModification.booking_id,
            `/admin/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
            onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View booking being changed</Link>}
          <DialogFooter><Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>Close</Button></DialogFooter>
        </> : selectedLesson ? <>
          <DetailSection title="Lesson">
            <dt className="text-muted-foreground">Coach</dt><dd>{selectedLesson.coach_name}</dd>
            <dt className="text-muted-foreground">Program</dt><dd>{selectedLesson.coaching_program_name}</dd>
          </DetailSection>
          <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={{ ...selectedLesson,
            location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }} /></DetailSection>
          <DetailSection title="Customer contact">
            <dt className="text-muted-foreground">Name</dt><dd>{selectedLesson.customer_name}</dd>
            <dt className="text-muted-foreground">Email</dt><dd>{selectedLesson.customer_email}</dd>
            <dt className="text-muted-foreground">Phone</dt><dd>{selectedLesson.customer_phone}</dd>
          </DetailSection>
          {/* Coaches open only their own lessons, from the Coach Calendar. */}
          <Link href={coachLessonLinkFrom(selectedLesson.id, `/coach/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
            onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View lesson details</Link>
          {selectedLesson.cancellation.availability !== "unavailable" && <DialogFooter>
            <CoachLessonReschedule lesson={selectedLesson} cancellation={selectedLesson.cancellation}
              onStart={() => { dialogRef.current?.close(); setSelectedOccupancyId(null); }} />
            <CoachLessonCancellation lesson={{ ...selectedLesson, location_name: location.name, court_name: selectedCourtName }}
              cancellation={selectedLesson.cancellation} onPendingChange={setCancelPending}
              onCancelled={() => { dialogRef.current?.close(); setSelectedOccupancyId(null); setSelection(null); }} />
          </DialogFooter>}
        </> : selectedBooking ? <>
          {!editing && <>
          <BookingDetails booking={{ ...selectedBooking, location_name: selectedBooking.location_name ?? location.name,
            location_timezone: selectedBooking.location_timezone ?? location.timezone, court_name: selectedBooking.court_name ?? selectedCourtName }} />
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Customer type</dt><dd>{selectedBooking.account_user_id === null ? "Guest" : "Authenticated customer"}</dd>
            <dt className="text-muted-foreground">Currency</dt><dd>{selectedBooking.currency}</dd>
            <dt className="text-muted-foreground">Payment method</dt><dd>{selectedBooking.payment_method === "online" ? "Online" : "Pay at club"}</dd>
            {selectedBooking.payment_status && <>
              <dt className="text-muted-foreground">Payment status</dt><dd>{financialStatusLabel(selectedBooking.payment_status)}</dd>
            </>}
          </dl>
          {canManage && <Link href={adminBookingLinkFrom(selectedBooking.id,
            `/admin/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
            // A preserved (hidden) Calendar route must not keep its modal open over Booking Details.
            onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View full booking details</Link>}
          {/* Coaches open only their own lessons, from the Coach Calendar. */}
          {!canManage && !!actorUserId && selectedBooking.coach_user_id === actorUserId && <Link href={coachLessonLinkFrom(selectedBooking.id,
            `/coach/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
            onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View lesson details</Link>}
          </>}
          {editing ? <BookingEditForm booking={selectedBooking} location={location}
            actions={ownBookingActions}
            onCancel={() => setEditing(false)} onPendingChange={setCancelPending}
            onSaved={async () => { dialogRef.current?.close(); setSelectedOccupancyId(null); setEditing(false);
              setSelection(null); router.refresh(); }} />
            : <DialogFooter>
            {ownsBooking && !canManage && <CustomerBookingCancellation
              booking={{ ...selectedBooking, starts_at_instant: localStartInstant(location.timezone, selectedBooking.booking_date, selectedBooking.starts_at_minute),
                location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }} staff
              onEdit={() => setEditing(true)} onPendingChange={setCancelPending}
              onCancelled={async () => { dialogRef.current?.close(); setSelectedOccupancyId(null); setSelection(null); router.refresh(); }} />}
            {canManage && isReservationBeforeStart({ ...selectedBooking, location_timezone: location.timezone }, new Date()) && <AdminBookingEdit bookingId={selectedBooking.id} onStart={() => { dialogRef.current?.close(); setSelectedOccupancyId(null); }} />}
            {canManage && isReservationBeforeStart({ ...selectedBooking, location_timezone: location.timezone }, new Date()) && <AdminBookingCancellation
              booking={{ ...selectedBooking, location_name: location.name, court_name: selectedCourtName }}
              refundAvailable={selectedBooking.stripe_refund_available} onPendingChange={setCancelPending}
              onCancelled={() => { dialogRef.current?.close(); setSelectedOccupancyId(null); setSelection(null); router.refresh(); }} />}
            <Button type="button" variant="secondary" disabled={cancelPending} onClick={() => dialogRef.current?.close()}>Close</Button>
          </DialogFooter>}
        </> : selectedReservation && editing && !editToken ? <div className="mt-4 min-h-20 text-sm" aria-busy={!editError}>
          {editError && <Button type="button" variant="text" className="ml-2 font-semibold underline" onClick={openEdit}>Retry</Button>}
        </div> : selectedReservation && editing ? <ReservationEditForm key={selectedReservation.id} reservation={{ ...selectedReservation,
          location_name: location.name, location_timezone: location.timezone, court_name: selectedCourtName }}
          inProgress={editInProgress} loadAvailability={loadReservationEdit}
          onPendingChange={setCancelPending}
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
            if (!canManage) return editOwnReservationAction(parsed.data);
            const result = await editAdminReservationAction(parsed.data);
            if (result.ok) setUpdatedReservation({ ...selectedReservation, ...result.reservation });
            return result;
          }}
          onSaved={async () => { setEditing(false); setEditToken(null);
            if (!canManage) { dialogRef.current?.close(); setSelectedOccupancyId(null); }
            router.refresh(); }}
          onStale={async () => { if (canManage) { setEditing(false); setEditToken(null); setUpdatedReservation(null); }
            router.refresh(); }} /> : selectedReservation ? <>
        <ReservationDetailsView reservation={{ ...selectedReservation, location_name: location.name,
            location_timezone: location.timezone,
            court_name: selectedCourtName }}>
          <dt className="text-muted-foreground">Created by</dt><dd>{selectedReservation.creator_name || "Unknown creator"}</dd>
          {selectedReservation.creator_email && <><dt className="text-muted-foreground">Email</dt><dd>{selectedReservation.creator_email}</dd></>}
          {selectedReservation.creator_phone && <><dt className="text-muted-foreground">Phone</dt><dd>{selectedReservation.creator_phone}</dd></>}
        </ReservationDetailsView>
        {canManage && <Link href={adminReservationLinkFrom(selectedReservation.id,
          `/admin/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
          onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View full reservation details</Link>}
        {!canManage && ownsReservation && <Link href={coachReservationLinkFrom(selectedReservation.id,
          `/coach/bookings?${new URLSearchParams({ view: "calendar", location: location.id, date })}`)}
          onClick={() => dialogRef.current?.close()} className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View full reservation details</Link>}
        <DialogFooter>
          {canEditReservation && <Button type="button" variant="secondary" disabled={cancelPending} onClick={openEdit}>Edit reservation</Button>}
          {canCancelReservation && <Button ref={cancelButtonRef} type="button" variant="destructive" disabled={cancelPending}
            onClick={() => {  setConfirming(true); }}>Cancel reservation</Button>}
          <Button type="button" variant="secondary" disabled={cancelPending} onClick={() => dialogRef.current?.close()}>Close</Button></DialogFooter>
        </> : selectedGenericOccupancy ? <>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Location</dt><dd>{location.name}</dd>
            <dt className="text-muted-foreground">Court</dt><dd>{selectedCourtName}</dd>
            <dt className="text-muted-foreground">Date</dt><dd>{reservationDateLabel(date)}</dd>
            <dt className="text-muted-foreground">Time</dt><dd>{minuteToTime(selectedGenericOccupancy.starts_at_minute)}–{minuteToTime(selectedGenericOccupancy.ends_at_minute)} ({location.timezone})</dd>
          </dl>
          <DialogFooter><Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>Close</Button></DialogFooter>
        </> : null}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && !selectedBooking && canCancelReservation} title="Cancel reservation?"
      message={selectedReservation ? `${location.name} · ${selectedCourtName}\n${reservationDateLabel(selectedReservation.booking_date)} · ${minuteToTime(selectedReservation.starts_at_minute)}–${minuteToTime(selectedReservation.ends_at_minute)}\nCreated by\n${selectedReservation.creator_name || "Unknown creator"}\n\nThis will free the court for other bookings and reservations.` : ""}
      confirmLabel="Cancel reservation" pendingLabel="Cancelling reservation…" cancelLabel="Keep reservation" pending={cancelPending}
      onConfirm={cancelReservation}
      onClose={() => { if (!cancelPending) setConfirming(false); }} returnFocusRef={cancelButtonRef} />
  </>;
}
