"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminBookingCancellation, type AdminCancellableBooking } from "@/app/admin/reservations/admin-booking-cancellation";
import { adminBookingEditable, type AdminCancellationAvailability } from "@/lib/bookings/admin-history";
import { AdminBookingEdit } from "../admin-booking-editor";

const unavailableMessages: Partial<Record<AdminCancellationAvailability, string>> = {
  started: "This booking has started and can no longer be cancelled.",
  cancellation_pending: "Cancellation requested. The booking stays confirmed until the refund is confirmed.",
  change_pending: "A change to this booking is still being processed. Cancellation is available once it finishes.",
};

export function BookingActions({ booking, availability, startsAt, refundAvailable }: {
  booking: AdminCancellableBooking; availability: AdminCancellationAvailability; startsAt: string; refundAvailable: boolean;
}) {
  const router = useRouter();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (availability !== "eligible") return;
    const timer = setTimeout(() => setStarted(true), Math.max(0, Math.min(2_147_483_647, Date.parse(startsAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [availability, startsAt]);
  const current = availability === "eligible" && started ? "started" : availability;
  if (current === "unavailable") return null;
  return <section aria-label="Booking actions" className="mb-6 flex max-w-4xl flex-wrap items-center gap-3">
    {current === "eligible" ? <>
      {adminBookingEditable({ availability: current }) && <AdminBookingEdit bookingId={booking.id} />}
      <AdminBookingCancellation booking={booking} refundAvailable={refundAvailable} onCancelled={() => router.refresh()} />
    </> : <p role="status" className="text-sm text-muted-foreground">{unavailableMessages[current]}</p>}
  </section>;
}
