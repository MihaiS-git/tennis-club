"use client";

import { useId, useRef, useState } from "react";
import { BookingDetails } from "@/components/booking-details";
import { Button } from "@/components/button";
import { DialogFooter, DialogHeader } from "@/components/dialog-layout";
import { ModalDialog } from "@/components/modal-dialog";
import type { AdminBookingDetails } from "@/lib/bookings/admin-details";
import { loadAdminBookingDetailsAction } from "./actions";

const statusLabels = { confirmed: "Confirmed", cancelled: "Cancelled", pending_payment: "Payment pending", failed: "Failed", expired: "Expired" };

export function NotificationBookingDetails({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  const [booking, setBooking] = useState<AdminBookingDetails | null>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const titleId = useId();

  async function load() {
    const current = ++request.current;
    setBooking(null); setError(""); setOpen(true);
    try {
      const result = await loadAdminBookingDetailsAction(bookingId);
      if (current !== request.current) return;
      if (result) setBooking(result);
      else setError("This booking is no longer available.");
    } catch {
      if (current === request.current) setError("Unable to load booking details. Try again.");
    }
  }

  return <>
    <button ref={trigger} type="button" title={bookingId} onClick={() => void load()}
      className="font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">
      <span aria-hidden="true">#{bookingId.slice(0, 8)}</span><span className="sr-only">Booking {bookingId}</span>
    </button>
    {open && <ModalDialog ref={dialog} active aria-labelledby={titleId}
      onClose={() => { ++request.current; setOpen(false); trigger.current?.focus(); }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
      <DialogHeader titleId={titleId} title="Booking details" status={booking ? statusLabels[booking.status] : undefined}
        onClose={() => dialog.current?.close()} />
      {booking ? <>
        <BookingDetails booking={booking} />
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Customer type</dt><dd>{booking.account_user_id ? "Authenticated customer" : "Guest"}</dd>
          <dt className="text-muted-foreground">Currency</dt><dd>{booking.currency}</dd>
          <dt className="text-muted-foreground">Payment method</dt><dd>{booking.payment_method === "online" ? "Online" : "Pay at club"}</dd>
        </dl>
      </> : error ? <div className="mt-4"><p role="alert">{error}</p>
        <Button type="button" variant="subtle" fullWidth={false} onClick={() => void load()}>Retry</Button></div>
        : <p role="status" className="mt-4">Loading booking details…</p>}
      <DialogFooter><Button type="button" variant="subtle" fullWidth={false} onClick={() => dialog.current?.close()}>Close</Button></DialogFooter>
    </ModalDialog>}
  </>;
}
