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
  const [error, setError] = useState("");
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
    setPending(true); onPendingChange(true); setError("");
    try {
      const result = await cancelOwnCustomerBookingAction(booking.id);
      if (!result.ok) { setError(result.message); return; }
      toast.success(cancelledBookingMessage(result.refundStatus));
      setConfirming(false);
      await onCancelled();
    } catch {
      setError("Unable to cancel this booking. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false); onPendingChange(false);
    }
  }

  return <>
    {eligibility === "eligible" && onEdit && <button type="button" disabled={pending}
      onClick={onEdit} className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold text-primary">Edit booking</button>}
    {eligibility === "eligible" ? <button ref={triggerRef} type="button" disabled={pending}
      onClick={() => { setNow(new Date()); setError(""); setConfirming(true); }}
      className="min-h-10 rounded-control border border-danger px-4 text-sm font-semibold text-danger">Cancel booking</button>
      : <p className="text-sm text-muted-foreground">{eligibility === "started"
        ? "Cancellation is no longer available because this booking has started."
        : `Cancellation is no longer available. This booking requires ${customerCancellationNoticeLabel(booking.cancellation_notice_minutes)}.`}</p>}
    <ConfirmationDialog open={confirming} title="Cancel booking?"
      message={`${booking.location_name} · ${booking.court_name}\nThis will cancel your booking and free the court.`}
      confirmLabel="Cancel booking" cancelLabel="Keep booking" pending={pending} error={error}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef} />
  </>;
}
