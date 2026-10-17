import "server-only";

import type { MailMessage } from "../mail/brevo";
import type { RevisionSnapshot } from "../bookings/revision";
import { customerCancellationNoticeLabel, guestCancellationInstruction } from "../bookings/self-cancellation";

type BookingEmailSchedule = {
  booking_date: string;
  starts_at_minute: number;
  ends_at_minute: number;
  court_name: string;
};
export type BookingEmailEvent = {
  recipient: string;
  event_kind: "confirmed" | "customer_cancelled" | "admin_cancelled" | "customer_rescheduled"
    // Definitive outcomes of requested changes; transient uncertainty sends nothing.
    | "cancellation_failed" | "modification_failed" | "refund_incomplete"
    // Captured after the checkout ended: no booking, full refund requested.
    | "late_payment_refund";
  payload: BookingEmailSchedule & {
    booking_id: string;
    customer_name: string;
    location_name: string;
    timezone: string;
    total_amount_minor: number;
    currency: string;
    previous: BookingEmailSchedule | null;
    // requested: legacy/compensation wording that promises no completion.
    refund_status?: "requested" | "completed" | "incomplete";
    refund_amount_minor?: number;
    // Guest bookings only: snapshotted notice for staff-handled cancellation instructions.
    guest_cancellation_notice_minutes?: number;
  };
};

export function bookingNotification(kind: BookingEmailEvent["event_kind"], revision: RevisionSnapshot,
  options: { previous?: RevisionSnapshot; refundRequested?: boolean; refundStatus?: "completed" | "incomplete";
    refund?: { amountMinor: number; currency: string }; guest?: boolean } = {}): BookingEmailEvent {
  const previous = options.previous;
  const refundStatus = options.refundStatus ?? (options.refundRequested ? "requested" as const : undefined);
  return { event_kind: kind, recipient: revision.customerEmail, payload: {
    booking_id: revision.bookingId, customer_name: revision.customerName, location_name: revision.locationName,
    timezone: revision.timezone, court_name: revision.courtName, booking_date: revision.bookingDate,
    starts_at_minute: revision.startMinute, ends_at_minute: revision.endMinute,
    total_amount_minor: revision.totalAmountMinor, currency: options.refund?.currency ?? revision.currency,
    previous: previous ? { court_name: previous.courtName, booking_date: previous.bookingDate,
      starts_at_minute: previous.startMinute, ends_at_minute: previous.endMinute } : null,
    ...(refundStatus ? { refund_status: refundStatus } : {}),
    ...(options.refund ? { refund_amount_minor: options.refund.amountMinor } : {}),
    // Provider confirmations carry no guest scope; their caller supplies booking ownership.
    ...(kind === "confirmed" && (options.guest ?? revision.actorScope === "guest")
      ? { guest_cancellation_notice_minutes: revision.cancellationNoticeMinutes } : {}),
  } };
}
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
function interval(value: BookingEmailSchedule) {
  return `${value.booking_date}, ${time(value.starts_at_minute)}–${time(value.ends_at_minute)}, ${value.court_name}`;
}
const subjects: Record<BookingEmailEvent["event_kind"], string> = {
  confirmed: "Booking confirmed", customer_cancelled: "Booking cancelled", admin_cancelled: "Booking cancelled",
  customer_rescheduled: "Booking rescheduled", cancellation_failed: "Booking cancellation not completed",
  modification_failed: "Booking change not completed", refund_incomplete: "Refund requires attention",
  late_payment_refund: "Payment received after checkout ended",
};
export function renderBookingEmail(event: BookingEmailEvent): MailMessage {
  const p = event.payload;
  const kind = event.event_kind;
  const cancelled = kind === "customer_cancelled" || kind === "admin_cancelled";
  const rescheduled = kind === "customer_rescheduled";
  const explanation = kind.startsWith("admin_") ? "The club administrator has " : "You have ";
  const intro = cancelled ? `${explanation}cancelled your booking.`
    : rescheduled ? `${explanation}rescheduled your booking.`
    : kind === "cancellation_failed" ? "Your cancellation request could not be completed because the refund could not be processed. No money was returned and your booking remains confirmed. You can request the cancellation again or contact the club."
    : kind === "modification_failed" ? "Your requested booking change could not be completed. Your original booking is unchanged."
    : kind === "refund_incomplete" ? `A refund${p.refund_amount_minor ? ` of ${money(p.refund_amount_minor, p.currency)}` : ""} for your booking could not be completed automatically. The club will contact you to resolve it.`
    : kind === "late_payment_refund" ? `Your payment${p.refund_amount_minor ? ` of ${money(p.refund_amount_minor, p.currency)}` : ""} was received after this checkout had already expired or been cancelled, so no booking was made. A full refund has been requested. It can take several business days to appear on your statement; you will be contacted if it cannot be completed.`
    : "Your court booking is confirmed.";
  const lines = [`Hello ${p.customer_name},`, "", intro, "",
    `Booking reference: ${p.booking_id}`, `Location: ${p.location_name}`, `Timezone: ${p.timezone}`];
  if (rescheduled && p.previous) lines.push(`Previous: ${interval(p.previous)}`);
  lines.push(`${rescheduled ? "New schedule" : "Schedule"}: ${interval(p)}`);
  if (!cancelled && kind !== "refund_incomplete" && kind !== "late_payment_refund") lines.push(`Booking total: ${money(p.total_amount_minor, p.currency)}`);
  if (cancelled && p.refund_status === "requested") lines.push("Your full payment refund has been requested.");
  if (cancelled && p.refund_status === "completed") lines.push("Your payment has been refunded.");
  if (rescheduled && p.refund_status === "completed") lines.push("The price difference has been refunded.");
  if ((cancelled || rescheduled) && p.refund_status === "incomplete")
    lines.push("Part of your refund could not be completed automatically. The club will contact you to resolve it.");
  if (kind === "modification_failed" && p.refund_status === "requested")
    lines.push("The additional payment you made for this change is being refunded.");
  if (p.guest_cancellation_notice_minutes !== undefined)
    lines.push("", "Cancellation terms", `This booking requires ${customerCancellationNoticeLabel(p.guest_cancellation_notice_minutes)}.`, guestCancellationInstruction);
  return { to: event.recipient, subject: subjects[kind], text: lines.join("\n") };
}
