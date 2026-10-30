"use client";


import { toast } from "sonner";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { Button } from "@/components/button";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { customerCancellationEligibility, customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";
import { cancelOwnCustomerBookingAction } from "./actions";

export function CustomerBookingCancellation({ booking, staff, onCancelled, onPendingChange, onEdit }: {
  onEdit?: () => void;
  booking: PersonalCustomerBooking; staff: boolean; onCancelled: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [parentDialog, setParentDialog] = useState<HTMLDialogElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const eligibility = customerCancellationEligibility(booking, staff, now);

  useEffect(() => {
    if (eligibility !== "eligible") return;
    const start = Date.parse(booking.starts_at_instant);
    const expires = staff || booking.cancellation_notice_minutes === 0
      ? start : start - booking.cancellation_notice_minutes * 60_000 + 1;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, Math.min(2_147_483_647, expires - now.getTime())));
    return () => clearTimeout(timer);
  }, [booking, staff, now, eligibility]);

  async function cancel() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); onPendingChange(true);
    const notification = toast.loading("Cancelling booking…");
    let cancelledMessage: string | null = null;
    try {
      const result = await cancelOwnCustomerBookingAction(booking.id);
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      cancelledMessage = cancelledBookingMessage(result);
      setConfirming(false);
      // Report the authoritative result before the separate activity refresh.
      // A slow refresh must not withhold confirmation of a completed cancellation.
      toast.success(cancelledMessage, { id: notification });
      await onCancelled();
    } catch {
      if (cancelledMessage) toast.warning(cancelledMessage, { id: notification, description: "Unable to refresh details. Reopen your activity to see the cancellation." });
      else toast.error("Unable to cancel this booking. Try again.", { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false); onPendingChange(false);
    }
  }

  // A requested change waits for its verified refund; the booking stays confirmed.
  if (booking.pending_change) return <p role="status" className="text-sm text-muted-foreground">
    {booking.pending_change === "cancellation"
      ? "Cancellation in progress. Your booking stays confirmed until the refund is confirmed."
      : "Your booking change is waiting for its refund to be confirmed. The current booking stays unchanged until then."}
  </p>;
  return <>
    {eligibility === "eligible" && onEdit && !booking.payment_pending && <Button type="button" variant="secondary" disabled={pending}
      onClick={onEdit}>{booking.includes_coaching ? "Reschedule" : "Edit booking"}</Button>}
    {eligibility === "eligible" ? <Button ref={triggerRef} type="button" variant="destructive" disabled={pending}
      onClick={(event) => { setParentDialog(event.currentTarget.closest("dialog")); setNow(new Date()); setConfirming(true); }}>Cancel booking</Button>
      : <p className="text-sm text-muted-foreground">{eligibility === "started"
        ? "Cancellation is no longer available because this booking has started."
        : `Cancellation is no longer available. This booking requires ${customerCancellationNoticeLabel(booking.cancellation_notice_minutes)}.`}</p>}
    <ConfirmationDialog parentDialog={parentDialog} open={confirming} title="Cancel booking?"
      message={`${booking.location_name} · ${booking.court_name}\n${reservationDateLabel(booking.booking_date)} · ${minuteToTime(booking.starts_at_minute)}–${minuteToTime(booking.ends_at_minute)} (${booking.location_timezone})\n${booking.includes_coaching ? `Coach: ${booking.coach_name ?? "Assigned coach"}\n` : ""}\nThis will cancel your booking and free the court.`}
      confirmLabel="Confirm cancellation" pendingLabel="Cancelling booking…" cancelLabel="Keep booking" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef}>
      <p className="mt-3 text-sm">{booking.payment_method === "pay_at_club"
        ? "No online refund applies. Payments made at the club are handled by the club."
        : "Captured online funds will be refunded automatically. If a refund is required, your booking stays confirmed until the refund is confirmed."}</p>
    </ConfirmationDialog>
  </>;
}
