import { cleanupBookingEvidence, insertBookingRecords } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkoutPersistence } from "@/lib/payments/domain";
import { inTransaction } from "@/lib/db/transaction";
import { assertTestEnvironment } from "../local/environment.mjs";

export type CheckoutFixtureInput = {
  courtId: string; bookingDate: string; startMinute: number; endMinute: number; accountUserId: string | null;
  customerName: string; customerEmail: string; customerPhone: string; totalAmountMinor: number; currency: string;
  paymentMethod: "online" | "pay_at_club"; provider: string | null; holdSeconds: number;
};

// Explicit transactional fixture persistence. Application policy tests use createCustomerBooking.
// Database failures propagate unchanged, so constraint tests can assert their SQLSTATE.
export async function insertCheckoutFixture(input: CheckoutFixtureInput) {
  assertTestEnvironment();
  return inTransaction(async (manager) => {
    const facts = z.array(z.object({ name: z.string(), location_name: z.string(), timezone: z.string(), notice: z.number(), now: z.string() }))
      .parse(await manager.query(`SELECT c.name, l.name AS location_name, l.timezone,
        l.customer_cancellation_notice_minutes AS notice, clock_timestamp()::text AS now
        FROM public.courts c JOIN public.locations l ON l.id=c.location_id WHERE c.id=$1`, [input.courtId]));
    const context = facts[0];
    if (!context) throw new Error("Checkout fixture court not found.");
    const id = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
    const lifecycle = checkoutPersistence(input.paymentMethod);
    const expires = input.paymentMethod === "online" ? new Date(Date.parse(context.now) + input.holdSeconds * 1000).toISOString() : null;
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [reservationId,input.courtId,input.bookingDate,input.startMinute,input.endMinute,lifecycle.reservation_status,expires]);
    await insertBookingRecords(manager, { id,reservation_id:reservationId,account_user_id:input.accountUserId,
      customer_name:input.customerName,customer_email:input.customerEmail,customer_phone:input.customerPhone,
      total_amount_minor:input.totalAmountMinor,currency:input.currency,payment_method:input.paymentMethod,
      cancellation_notice_minutes:context.notice,status:lifecycle.booking_status });
    await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,amount_minor,currency,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[attemptId,id,input.paymentMethod,input.provider,input.totalAmountMinor,input.currency,lifecycle.attempt_status,expires]);
    return { booking_id:id,reservation_id:reservationId,payment_attempt_id:attemptId,hold_expires_at:expires,status:lifecycle.booking_status };
  });
}

export async function cleanupBookingFixtures(selection: { bookingIds: string[] } | { reservationIds: string[] } | { courtIds: string[] }) {
  return inTransaction(manager => cleanupBookingEvidence(manager, selection));
}

// Accepts one or more rows in the shape insertBookingRecords validates.
export async function insertBookingFixture(input: unknown) {
  assertTestEnvironment();
  await inTransaction(manager => insertBookingRecords(manager, input));
}

// Current-contract assertion projection, never another persistence representation.
export async function readBookingContracts(client: SupabaseClient, input: { ids?: string[]; reservationIds?: string[] } = {}) {
  const { data, error } = await client.from("bookings").select("*,revision:booking_revisions!bookings_current_revision_fkey(*)")
    .in(input.ids ? "id" : "reservation_id", input.ids ?? input.reservationIds ?? []);
  if (error) throw error;
  return (data ?? []).map(row => { const { revision, ...booking } = row; return { ...revision, ...booking }; });
}

// Deliberately seed a different current contract for policy/concurrency fixtures.
// This appends real immutable records; it never updates revision evidence.
export async function appendBookingContractFixture(id: string, input: {
  total_amount_minor?: number; customer_email?: string; cancellation_notice_minutes?: number; payment_method?: "online" | "pay_at_club";
  booking_date?: string; starts_at_minute?: number; ends_at_minute?: number;
}, manager?: import("typeorm").EntityManager) {
  const { findBookingForUpdate } = await import("@/lib/db/repositories/bookings.repository");
  const { advanceRevision } = await import("@/lib/db/repositories/booking-revisions.repository");
  const { buildBookingRevision } = await import("@/lib/bookings/revision");
  const work = async (m: import("typeorm").EntityManager) => {
    const b = await findBookingForUpdate(m, id);
    if (!b) throw new Error("Missing booking fixture");
    const terms = { ...b.revision, totalAmountMinor: input.total_amount_minor ?? b.total_amount_minor,
      customerEmail: input.customer_email ?? b.customer_email, paymentMethod: input.payment_method ?? b.payment_method,
      cancellationNoticeMinutes: input.cancellation_notice_minutes ?? b.cancellation_notice_minutes };
    const start = input.starts_at_minute ?? terms.startMinute;
    const end = input.ends_at_minute ?? terms.endMinute;
    // These controlled schedule fixtures preserve duration and pricing evidence.
    if (end - start !== terms.endMinute - terms.startMinute)
      throw new Error("Schedule fixture must preserve duration");
    terms.pricingEvidence = { ...terms.pricingEvidence, slots: terms.pricingEvidence.slots.map(slot =>
      ({ ...slot, minute: slot.minute + start - terms.startMinute })) };
    terms.bookingDate = input.booking_date ?? terms.bookingDate;
    terms.startMinute = start;
    terms.endMinute = end;
    if (input.booking_date !== undefined || input.starts_at_minute !== undefined || input.ends_at_minute !== undefined)
      await m.query(`UPDATE public.court_reservations SET booking_date=$2, starts_at_minute=$3, ends_at_minute=$4
        WHERE id=$1`, [b.reservation_id, terms.bookingDate, start, end]);
    if (input.total_amount_minor !== undefined) {
      const slots = terms.pricingEvidence.slots, rate = Math.floor(terms.totalAmountMinor * 2 / slots.length);
      const remainder = terms.totalAmountMinor * 2 - rate * slots.length;
      terms.pricingEvidence = { ...terms.pricingEvidence, slots: slots.map((s,i) => ({ ...s, hourlyMinor: rate + (i < remainder ? 1 : 0) })) };
    }
    const revision = buildBookingRevision(terms, { id: randomUUID(), bookingId: id, kind: "rescheduled", bookingState: "confirmed",
      operationKey: randomUUID(), intentHash: "fixture", actorUserId: b.account_user_id, actorScope: "customer", recordedAt: new Date(),
      adjustmentId: null, cancellationCause: null }, b.revision);
    await advanceRevision(m, { revision, previousId: b.current_revision_id, status: "confirmed" });
  };
  assertTestEnvironment();
  return manager ? work(manager) : inTransaction(work);
}
