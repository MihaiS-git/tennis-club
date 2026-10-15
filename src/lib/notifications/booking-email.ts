import "server-only";

import { sendMail, type MailMessage } from "../mail/brevo";
import type { RevisionSnapshot } from "../bookings/revision";

type BookingEmailSchedule = {
  booking_date: string;
  starts_at_minute: number;
  ends_at_minute: number;
  court_name: string;
};
export type BookingEmailEvent = {
  recipient: string;
  event_kind: "confirmed" | "customer_cancelled" | "admin_cancelled" | "customer_rescheduled";
  payload: BookingEmailSchedule & {
    booking_id: string;
    customer_name: string;
    location_name: string;
    timezone: string;
    total_amount_minor: number;
    currency: string;
    previous: BookingEmailSchedule | null;
    refund_status?: "requested";
  };
};

export function bookingNotification(kind: BookingEmailEvent["event_kind"], revision: RevisionSnapshot,
  options: { previous?: RevisionSnapshot; refundRequested?: boolean } = {}): BookingEmailEvent {
  const previous = options.previous;
  return { event_kind: kind, recipient: revision.customerEmail, payload: {
    booking_id: revision.bookingId, customer_name: revision.customerName, location_name: revision.locationName,
    timezone: revision.timezone, court_name: revision.courtName, booking_date: revision.bookingDate,
    starts_at_minute: revision.startMinute, ends_at_minute: revision.endMinute,
    total_amount_minor: revision.totalAmountMinor, currency: revision.currency,
    previous: previous ? { court_name: previous.courtName, booking_date: previous.bookingDate,
      starts_at_minute: previous.startMinute, ends_at_minute: previous.endMinute } : null,
    ...(options.refundRequested ? { refund_status: "requested" as const } : {}),
  } };
}
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
function interval(value: BookingEmailSchedule) {
  return `${value.booking_date}, ${time(value.starts_at_minute)}–${time(value.ends_at_minute)}, ${value.court_name}`;
}
export function renderBookingEmail(event: BookingEmailEvent): MailMessage {
  const p = event.payload;
  const cancelled = event.event_kind.endsWith("cancelled");
  const rescheduled = event.event_kind.endsWith("rescheduled");
  const subject = cancelled ? "Booking cancelled" : rescheduled ? "Booking rescheduled" : "Booking confirmed";
  const explanation = event.event_kind.startsWith("admin_") ? "The club administrator has " : "You have ";
  const lines = [`Hello ${p.customer_name},`, "", cancelled ? `${explanation}cancelled your booking.`
    : rescheduled ? `${explanation}rescheduled your booking.` : "Your court booking is confirmed.", "",
    `Booking reference: ${p.booking_id}`, `Location: ${p.location_name}`, `Timezone: ${p.timezone}`];
  if (rescheduled && p.previous) lines.push(`Previous: ${interval(p.previous)}`);
  lines.push(`${rescheduled ? "New schedule" : "Schedule"}: ${interval(p)}`);
  if (!cancelled) lines.push(`Booking total: ${(p.total_amount_minor / 100).toFixed(2)} ${p.currency}`);
  if (cancelled && p.refund_status === "requested") lines.push("Your full payment refund has been requested.");
  return { to: event.recipient, subject, text: lines.join("\n") };
}

// Call only after the booking/payment transaction commits. Delivery is best-effort.
export async function sendBookingNotification(event: BookingEmailEvent): Promise<void> {
  await sendMail(renderBookingEmail(event));
}
