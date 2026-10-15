"use client";

import { toast } from "sonner";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import { customerCancellationEligibility, customerCancellationNoticeLabel } from "@/lib/bookings/self-cancellation";
import { cancelOwnCustomerBookingAction } from "./actions";

export function CustomerBookingCancellation({ booking, staff, onCancelled, onPendingChange, onEdit }: {
  onEdit?: () => void;
  booking: PersonalCustomerBooking; staff: boolean; onCancelled: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const [now, setNow] = useState(() => new Date());
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
      await onCancelled();
      toast.success(cancelledMessage, { id: notification });
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
      ? "Cancellation in progress. Your booking stays confirmed until the refund is confirmed; you will be emailed if it cannot be completed."
      : "Your booking change is waiting for its refund to be confirmed. The current booking stays unchanged until then."}
  </p>;
  return <>
    {eligibility === "eligible" && onEdit && !booking.payment_pending && <button type="button" disabled={pending}
      onClick={onEdit} className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit booking</button>}
    {eligibility === "eligible" ? <button ref={triggerRef} type="button" disabled={pending}
      onClick={() => { setNow(new Date()); setConfirming(true); }}
      className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel booking</button>
      : <p className="text-sm text-muted-foreground">{eligibility === "started"
        ? "Cancellation is no longer available because this booking has started."
        : `Cancellation is no longer available. This booking requires ${customerCancellationNoticeLabel(booking.cancellation_notice_minutes)}.`}</p>}
    <ConfirmationDialog open={confirming} title="Cancel booking?"
      message={`${booking.location_name} · ${booking.court_name}\nThis will cancel your booking and free the court.`}
      confirmLabel="Cancel booking" cancelLabel="Keep booking" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef} />
  </>;
}
