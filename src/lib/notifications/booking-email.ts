import "server-only";

import { z } from "zod";
import type { MailMessage } from "../mail/adapter.ts";

const schedule = z.object({ booking_date: z.iso.date(), starts_at_minute: z.number().int().min(0).max(1439),
  ends_at_minute: z.number().int().min(1).max(1440), court_name: z.string().min(1) });
export const bookingEmailEventSchema = z.object({
  id: z.uuid(), lease_token: z.uuid(), recipient: z.email(),
  event_kind: z.enum(["confirmed", "customer_cancelled", "admin_cancelled", "customer_rescheduled", "admin_rescheduled"]),
  payload: schedule.extend({ booking_id: z.uuid(), customer_name: z.string(), location_name: z.string(), timezone: z.string(),
    total_amount_minor: z.number().int().nonnegative(), currency: z.string().length(3), previous: schedule.nullable(), refund_status: z.literal("requested").optional() }),
});
export type BookingEmailEvent = z.infer<typeof bookingEmailEventSchema>;

export function bookingNotification(kind: BookingEmailEvent["event_kind"], key: string,
  payload: BookingEmailEvent["payload"], recipient: string) {
  return { kind, key, recipient, payload };
}
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
function interval(value: z.infer<typeof schedule>) {
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
  return { idempotencyKey: event.id, to: event.recipient, subject, text: lines.join("\n") };
}
