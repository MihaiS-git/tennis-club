"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { cancelAdminCustomerBookingAction } from "./actions";

export type AdminCancellableBooking = {
  id: string; customer_name: string; location_name: string; court_name: string; booking_date: string;
  starts_at_minute: number; ends_at_minute: number; total_amount_minor: number; currency: LocationCurrency;
};

// The one Admin customer-booking cancellation control, shared by the Calendar preview
// and Booking Details. Callers decide visibility; the existing service decides eligibility,
// refunds and outcome, and its message is shown when it declines.
export function AdminBookingCancellation({ booking, refundAvailable, onCancelled, onPendingChange }: {
  booking: AdminCancellableBooking; refundAvailable: boolean;
  onCancelled: () => void | Promise<void>; onPendingChange?: (pending: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  async function cancel() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); onPendingChange?.(true);
    const notification = toast.loading("Cancelling…");
    try {
      const result = await cancelAdminCustomerBookingAction({ id: booking.id });
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      setConfirming(false);
      toast.success(cancelledBookingMessage(result), { id: notification });
      await onCancelled();
    } catch {
      toast.error("Unable to cancel this booking. Try again.", { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false); onPendingChange?.(false);
    }
  }
  return <>
    <button ref={triggerRef} type="button" disabled={pending} onClick={() => setConfirming(true)}
      className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel booking</button>
    <ConfirmationDialog open={confirming} title="Cancel booking?"
      message={`Customer\n${booking.customer_name}\n\n${booking.location_name} · ${booking.court_name}\n${reservationDateLabel(booking.booking_date)} · ${minuteToTime(booking.starts_at_minute)}–${minuteToTime(booking.ends_at_minute)}\n\nTotal\n${formatMoney(booking.total_amount_minor, booking.currency)} · ${booking.currency}\n\nThis will cancel the booking and free the court.`}
      confirmLabel="Cancel booking" cancelLabel="Keep booking" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef}>
      {refundAvailable && <p className="mt-3 text-sm">Captured online funds will be refunded automatically.</p>}
    </ConfirmationDialog>
  </>;
}
