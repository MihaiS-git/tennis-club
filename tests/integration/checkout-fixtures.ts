import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkoutPersistence } from "@/lib/payments/domain";
import { readCheckoutContext } from "@/lib/bookings/persistence";
import { bookingNotification } from "@/lib/notifications/booking-email";

// Inserts authoritative fixture snapshots through the final atomic persistence API.
// Application eligibility/pricing tests use createCustomerBooking instead.
export async function insertCheckoutFixture(db: SupabaseClient, input: unknown) {
  const value = z.object({ p_court_id: z.uuid(), p_booking_date: z.string(), p_starts_at_minute: z.number(), p_ends_at_minute: z.number(),
    p_account_user_id: z.uuid().nullable(), p_customer_name: z.string(), p_customer_email: z.string(), p_customer_phone: z.string(),
    p_total_amount_minor: z.number(), p_currency: z.string(), p_payment_method: z.enum(["online", "pay_at_club"]),
    p_provider: z.string().nullable(), p_hold_seconds: z.number() }).parse(input);
  const context = await readCheckoutContext(value.p_court_id, value.p_booking_date, value.p_starts_at_minute, db);
  if (!context) throw new Error("Checkout fixture court not found.");
  const id = randomUUID();
  return db.rpc("commit_checkout", { p_revision: context.revision,
    p_command: { booking_id: id, reservation_id: randomUUID(), attempt_id: randomUUID(), court_id: value.p_court_id,
      date: value.p_booking_date, start: value.p_starts_at_minute, end: value.p_ends_at_minute,
      account_user_id: value.p_account_user_id, customer_name: value.p_customer_name, customer_email: value.p_customer_email,
      customer_phone: value.p_customer_phone, amount: value.p_total_amount_minor, currency: value.p_currency,
      method: value.p_payment_method, provider: value.p_provider,
      cancellation_notice_minutes: context.location.customer_cancellation_notice_minutes,
      ...checkoutPersistence(value.p_payment_method), hold_seconds: value.p_payment_method === "online" ? value.p_hold_seconds : null },
    p_event: value.p_payment_method === "online" ? null : bookingNotification("confirmed", "confirmed", {
      booking_id: id, customer_name: value.p_customer_name, location_name: context.location.name, timezone: context.location.timezone,
      court_name: context.court.name, booking_date: value.p_booking_date, starts_at_minute: value.p_starts_at_minute,
      ends_at_minute: value.p_ends_at_minute, total_amount_minor: value.p_total_amount_minor, currency: value.p_currency, previous: null,
    }, value.p_customer_email),
  });
}

export function cancellationCommandFixture(id: string) {
  return { p_id: id, p_fingerprint: "forged", p_revision: 0, p_actor: null, p_scope: "admin",
    p_actor_expected: null, p_deadline: null, p_inclusive: false, p_refund: null, p_event: null };
}
export function rescheduleCommandFixture(id: string) {
  return { p_id: id, p_fingerprint: "forged", p_revision: 0, p_actor: null, p_scope: "admin",
    p_actor_expected: null, p_deadline: null, p_inclusive: false, p_schedule: {}, p_total: 1, p_event: null };
}
