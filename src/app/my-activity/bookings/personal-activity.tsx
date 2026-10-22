"use client";


import { toast } from "sonner";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
import { ModalDialog } from "@/components/modal-dialog";
import { ReservationDetailsView } from "@/components/reservation-details";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { activityBookingHref, activityHref, parseActivityQuery, type ActivitySearchParams } from "@/lib/bookings/activity-query";
import type { UpcomingActivity as Activity, UpcomingCourtActivity as CourtActivity } from "@/lib/bookings/activity-service";
import { upcomingBookingStatus, type PersonalCustomerBooking } from "@/lib/bookings/personal";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney } from "@/lib/pricing/money";
import { isReservationInProgress, isReservationUpcoming, type PersonalReservation } from "@/lib/reservations/personal";
import { BookingEditForm, type BookingEditActions } from "@/components/booking-edit-form";
import { cancelOwnReservationAction, dismissOwnBookingAdjustmentAction, loadPersonalActivityAction, loadOwnBookingEditDayAction, quoteOwnBookingAction, rescheduleOwnBookingAction } from "./actions";
import { ActivityControls } from "../activity-controls";
import { bookingTypeDetail, bookingTypeLabel } from "@/lib/bookings/booking-type";
import { ActivityRow, ActivityTable } from "../activity-table";
import { ActivityPagination } from "../activity-pagination";
import { CustomerBookingCancellation } from "./customer-booking-cancellation";
import { BookingPayment } from "../booking-payment";
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

export function PersonalActivity({ staff, userId, initialActivity, initialError, listQuery, deepLinkedBooking = null }: {
  staff: boolean; userId?: string; initialActivity: Activity | null; initialError: string; listQuery?: ActivitySearchParams;
  deepLinkedBooking?: PersonalCustomerBooking | null;
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
  const [selectedBooking, setSelectedBooking] = useState<PersonalCustomerBooking | null>(deepLinkedBooking);
  const [deepLinkedBookingId, setDeepLinkedBookingId] = useState(deepLinkedBooking?.id ?? null);
  if (deepLinkedBookingId !== (deepLinkedBooking?.id ?? null)) {
    setDeepLinkedBookingId(deepLinkedBooking?.id ?? null);
    setSelectedBooking(deepLinkedBooking);
  }
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bookingDialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLTableRowElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const adjustmentRef = useRef<string | null>(null);
  const titleId = useId();
  const paymentPending = activity?.bookings.some((row) => row.payment_pending || row.pending_change) ?? false;

  // Edit reappears once a processing modification payment or refund-backed change resolves.
  useEffect(() => {
    if (!paymentPending) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void loadPersonalActivityAction(listQuery).then((value) => {
        if (disposed) return;
        setActivity(value);
        setSelectedBooking((current) => current && (value.bookings.find((row) => row.id === current.id) ?? current));
      }).catch(() => { /* The next interval retries; the list stays usable. */ });
    }, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [paymentPending, listQuery]);

  useEffect(() => {
    if (error) toast.error(error, { action: { label: "Retry", onClick: () => setError("") } });
  }, [error]);

  useEffect(() => {
    if (activity || error) return;
    let cancelled = false;
    const notification = toast.loading("Loading your court activity…");
    loadPersonalActivityAction(listQuery).then((value) => {
      if (!cancelled) setActivity(value);
    }).catch(() => {
      if (!cancelled) setError("Unable to load your court activity. Try again.");
    });
    return () => { cancelled = true; toast.dismiss(notification); };
  }, [activity, error, listQuery]);

  async function cancel() {
    if (!selected || pending) return;
    setPending(true);
    let cancelled = false;
    const notification = toast.loading("Cancelling reservation…");
    try {
      const result = await cancelOwnReservationAction(selected.id);
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      cancelled = true;
      setConfirming(false);
      dialogRef.current?.close();
      setSelected(null);
      toast.success("Reservation cancelled.", { id: notification });
    } catch {
      toast.error("Unable to cancel this reservation. Try again.", { id: notification });
    } finally { setPending(false); }
    if (cancelled) {
      try { setActivity(await loadPersonalActivityAction(listQuery)); }
      catch { setActivity(null); setError("Unable to load your court activity. Try again."); }
    }
  }

  async function refreshCancelledBooking() {
    window.history.replaceState(null, "", activityHref("upcoming", parseActivityQuery(listQuery ?? {}, "upcoming", staff)));
    bookingDialogRef.current?.close();
    setSelectedBooking(null);
    try { setActivity(await loadPersonalActivityAction(listQuery)); }
    catch { setActivity(null); setError("Unable to load your court activity. Try again."); }
  }

  async function refreshEditedReservation() {
    setEditing(false);
    try {
      const refreshed = await loadPersonalActivityAction(listQuery);
      setActivity(refreshed);
      const current = refreshed.upcoming.find((row) => row.id === selected?.id);
      setSelected(current ?? null);
    } catch {
      setSelected(null);
      setActivity(null);
      setError("Unable to load your court activity. Try again.");
    }
  }

  if (!activity && !error) return <div aria-busy="true" className="min-h-20" />;
  if (error) return <button type="button" className="text-sm font-semibold underline" onClick={() => setError("")}>Retry loading court activity</button>;
  if (!activity) return null;

  function openDetails(item: CourtActivity, row: HTMLTableRowElement) {
    returnFocusRef.current = row; setEditing(false);
    if (item.kind === "booking") {
      window.history.replaceState(null, "", activityBookingHref("upcoming", query, item.row.id));
      setSelectedBooking(item.row);
    } else setSelected(item.row);
  }

  const list = (rows: CourtActivity[]) => <section aria-label="Upcoming">
    {rows.length ? <ActivityTable scope="upcoming" query={query}>
      {rows.map((item) => <ActivityRow key={`${item.kind}:${item.row.id}`}
        label={`Details for ${item.row.court_name} on ${dateLabel(item.row.booking_date)}`}
        onOpen={(row) => openDetails(item, row)}
        type={item.kind === "booking" ? bookingTypeLabel(item.row) : "Reservation"}
        typeDetail={item.kind === "booking" ? bookingTypeDetail(item.row) : undefined}
        location={item.row.location_name} court={item.row.court_name} date={dateLabel(item.row.booking_date)}
        time={`${timeLabel(item.row.starts_at_minute)}–${timeLabel(item.row.ends_at_minute)}`}
        duration={`${item.row.ends_at_minute - item.row.starts_at_minute} min`}
        total={item.kind === "booking" ? formatMoney(item.row.total_amount_minor, item.row.currency) : "—"}
        status={item.kind === "booking"
          ? <StatusBadge tone={upcomingBookingStatus(item.row).tone}>{upcomingBookingStatus(item.row).label}</StatusBadge>
          : <StatusBadge tone="neutral">Active</StatusBadge>} />)}
    </ActivityTable> : <p className="rounded-card border border-border bg-surface p-5 text-sm text-muted-foreground">No upcoming bookings or reservations match your filters.</p>}
  </section>;

  const query = parseActivityQuery(listQuery ?? {}, "upcoming", staff);
  return <>
    <ActivityControls staff={staff} scope="upcoming" query={query}
      options={{ locations: activity.locations, courts: activity.courts }} />
    {list(activity.ordered)}
    <ActivityPagination scope="upcoming" query={query}
      hasNext={activity.hasNext} empty={!activity.ordered.length} />
    {selectedBooking && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={bookingDialogRef} active aria-labelledby={`${titleId}-booking`}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
        onClose={() => {
          setSelectedBooking(null);
          window.history.replaceState(null, "", activityHref("upcoming", query));
          if (editing) {
            setEditing(false);
            // X discards an unpaid modification; a processing payment is left to the webhook.
            const adjustmentId = adjustmentRef.current;
            adjustmentRef.current = null;
            void (adjustmentId ? dismissOwnBookingAdjustmentAction(adjustmentId) : Promise.resolve())
              .catch(() => { /* The hold still ends at its deadline. */ })
              .then(() => loadPersonalActivityAction(listQuery)).then(setActivity).catch(() => {
                setActivity(null); setError("Unable to load your court activity. Try again.");
              });
          }
          returnFocusRef.current?.focus();
        }}
        className={`fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 has-[[data-booking-modification]]:max-w-lg ${editing ? "max-w-6xl" : "max-w-md"}`}>
        <DialogHeader titleId={`${titleId}-booking`} title={editing ? selectedBooking.includes_coaching ? "Reschedule lesson" : "Edit booking" : "Booking"} status={editing ? undefined : upcomingBookingStatus(selectedBooking).label}
          statusTone={upcomingBookingStatus(selectedBooking).tone} disabled={pending} onClose={() => bookingDialogRef.current?.close()} />
        {editing ? <BookingEditForm booking={selectedBooking}
          actions={ownBookingActions} onCancel={() => setEditing(false)} onPendingChange={setPending}
          onAdjustment={(id) => { adjustmentRef.current = id; }}
          onSaved={async () => {
            adjustmentRef.current = null;
            setEditing(false);
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
        {/* Re-read when polling reports a resolved payment, change or new total. */}
        <BookingPayment key={`${selectedBooking.id}:${selectedBooking.total_amount_minor}:${selectedBooking.payment_pending}:${selectedBooking.pending_change}`} bookingId={selectedBooking.id} />
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
          onSaved={refreshEditedReservation}
          onStale={refreshEditedReservation} /> : <>
        <ReservationDetails reservation={selected} />
        <DialogFooter>
          {staff && selected.status === "active" && activity.upcoming.some((row) => row.id === selected.id)
            && isReservationUpcoming(selected, new Date())
            && selected.created_by_user_id === userId && <>
            <button type="button" disabled={pending} onClick={() => {  setEditing(true); }}
              className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit reservation</button>
            <button ref={cancelButtonRef} type="button" disabled={pending} onClick={() => {  setConfirming(true); }}
              className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel reservation</button></>}
          <button type="button" disabled={pending} onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
        </>}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && !!selected} title="Cancel reservation?"
      message={selected ? `${selected.location_name} · ${selected.court_name}\n${dateLabel(selected.booking_date)} · ${timeLabel(selected.starts_at_minute)}–${timeLabel(selected.ends_at_minute)}\nThis will free the court for other bookings.` : ""}
      confirmLabel="Cancel reservation" cancelLabel="Keep reservation" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pending) setConfirming(false); }} returnFocusRef={cancelButtonRef} />
  </>;
}
