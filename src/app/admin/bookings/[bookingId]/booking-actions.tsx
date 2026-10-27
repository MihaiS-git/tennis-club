"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AdminBookingCancellation, type AdminCancellableBooking } from "@/app/admin/reservations/admin-booking-cancellation";
import { dismissOwnBookingAdjustmentAction } from "@/app/my-activity/bookings/actions";
import { BookingEditForm } from "@/components/booking-edit-form";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { ModalDialog } from "@/components/modal-dialog";
import type { AdminCancellationAvailability } from "@/lib/bookings/admin-history";

const unavailableMessages: Partial<Record<AdminCancellationAvailability, string>> = {
  started: "This booking has started and can no longer be cancelled.",
  cancellation_pending: "Cancellation requested. The booking stays confirmed until the refund is confirmed.",
  change_pending: "A change to this booking is still being processed. Cancellation is available once it finishes.",
};

// Only actions the existing services permit; cancelled, failed and expired bookings show none.
// Editing is the existing owner rescheduling form, offered only for the Admin's own court bookings.
export function BookingActions({ booking, availability, startsAt, refundAvailable, editable = false }: {
  booking: AdminCancellableBooking; availability: AdminCancellationAvailability; startsAt: string; refundAvailable: boolean;
  editable?: boolean;
}) {
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const adjustmentRef = useRef<string | null>(null);
  const [started, setStarted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  // An open page stops offering cancellation once the booking starts.
  useEffect(() => {
    if (availability !== "eligible") return;
    const timer = setTimeout(() => setStarted(true), Math.max(0, Math.min(2_147_483_647, Date.parse(startsAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [availability, startsAt]);
  const current = availability === "eligible" && started ? "started" : availability;
  if (current === "unavailable") return null;
  return <section aria-label="Booking actions" className="mb-6 flex max-w-4xl flex-wrap items-center gap-3">
    {current === "eligible" ? <>
      {editable && <Button type="button" variant="secondary" disabled={pending} onClick={() => setEditing(true)}>Edit booking</Button>}
      <AdminBookingCancellation booking={booking} refundAvailable={refundAvailable} onCancelled={() => router.refresh()} />
    </> : <p role="status" className="text-sm text-muted-foreground">{unavailableMessages[current]}</p>}
    {editing && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
        onClose={() => {
          setEditing(false);
          // X discards an unpaid modification, as in My Activity; a processing payment is left to the webhook.
          const adjustmentId = adjustmentRef.current;
          adjustmentRef.current = null;
          void (adjustmentId ? dismissOwnBookingAdjustmentAction(adjustmentId) : Promise.resolve())
            .catch(() => { /* The hold still ends at its deadline. */ }).then(() => router.refresh());
        }}
        className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-6xl overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 has-[[data-booking-modification]]:max-w-lg">
        <DialogHeader titleId={titleId} title="Edit booking" disabled={pending} onClose={() => dialogRef.current?.close()} />
        <BookingEditForm booking={booking} onCancel={() => dialogRef.current?.close()} onPendingChange={setPending}
          onAdjustment={(id) => { adjustmentRef.current = id; }}
          onSaved={async () => { adjustmentRef.current = null; dialogRef.current?.close(); }} />
      </ModalDialog>, document.body)}
  </section>;
}
