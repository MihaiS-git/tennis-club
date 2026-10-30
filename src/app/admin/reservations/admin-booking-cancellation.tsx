"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { cancelAdminCustomerBookingAction } from "./actions";

export type AdminCancellableBooking = {
  id: string; customer_name: string; location_name: string; court_name: string; booking_date: string;
  starts_at_minute: number; ends_at_minute: number; total_amount_minor: number; currency: LocationCurrency; coach_name?: string | null;
};

// The one Admin customer-booking cancellation control, shared by the Calendar preview
// and Booking Details. Callers decide visibility; the existing service decides eligibility,
// refunds and outcome, and its message is shown when it declines.
export function AdminBookingCancellation({ booking, refundAvailable, onCancelled, onPendingChange }: {
  booking: AdminCancellableBooking; refundAvailable: boolean;
  onCancelled: () => void | Promise<void>; onPendingChange?: (pending: boolean) => void;
}) {
  const [explanation, setExplanation] = useState("");
  const [parentDialog, setParentDialog] = useState<HTMLDialogElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  async function cancel() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); onPendingChange?.(true);
    const notification = toast.loading("Cancelling…");
    let cancelledMessage: string | null = null;
    try {
      const result = await cancelAdminCustomerBookingAction({ id: booking.id, ...(explanation.trim() ? { explanation: explanation.trim() } : {}) });
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      setConfirming(false);
      cancelledMessage = cancelledBookingMessage(result, "admin");
      toast.success(cancelledMessage, { id: notification });
      await onCancelled();
    } catch {
      if (cancelledMessage) toast.warning(cancelledMessage, { id: notification, description: "Unable to refresh details. Reopen the booking to see the cancellation." });
      else toast.error("Unable to cancel this booking. Try again.", { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false); onPendingChange?.(false);
    }
  }
  return <>
    <Button ref={triggerRef} type="button" variant="destructive" disabled={pending} onClick={(event) => { setParentDialog(event.currentTarget.closest("dialog")); setConfirming(true); }}>Cancel booking</Button>
    <ConfirmationDialog parentDialog={parentDialog} open={confirming} title="Cancel booking?"
      message={`Customer\n${booking.customer_name}\n${booking.coach_name ? `Coach: ${booking.coach_name}\n` : ""}\n${booking.location_name} · ${booking.court_name}\n${reservationDateLabel(booking.booking_date)} · ${minuteToTime(booking.starts_at_minute)}–${minuteToTime(booking.ends_at_minute)}\n\nTotal\n${formatMoney(booking.total_amount_minor, booking.currency)} · ${booking.currency}\n\nThis will cancel the booking and free the court.`}
      confirmLabel="Confirm cancellation" pendingLabel="Cancelling booking…" cancelLabel="Keep booking" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef}>
      <label className="mt-4 block text-sm font-medium">Cancellation explanation (optional)
        <textarea maxLength={500} rows={3} disabled={pending} value={explanation} onChange={e => setExplanation(e.target.value)}
          className="mt-1 w-full rounded-control border border-border bg-surface p-3 text-sm" />
      </label>
      {refundAvailable && <p className="mt-3 text-sm">Captured online funds will be refunded automatically. The booking stays confirmed until the refund is confirmed.</p>}
    </ConfirmationDialog>
  </>;
}
