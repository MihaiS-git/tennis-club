import { cleanupBookingEvidence, insertBookingRecords } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkoutPersistence } from "@/lib/payments/domain";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { assertTestEnvironment } from "../local/environment.mjs";

// Explicit transactional fixture persistence. Application policy tests use createCustomerBooking.
export async function insertCheckoutFixture(db: SupabaseClient, input: unknown) {
  // Fixture callers must supply the guarded local tooling client.
  assertTestEnvironment();
  if (!db) throw new Error("Checkout fixtures require the isolated test client.");
  const value = z.object({ p_court_id: z.uuid(), p_booking_date: z.string(), p_starts_at_minute: z.number(), p_ends_at_minute: z.number(),
    p_account_user_id: z.uuid().nullable(), p_customer_name: z.string(), p_customer_email: z.string(), p_customer_phone: z.string(),
    p_total_amount_minor: z.number(), p_currency: z.string(), p_payment_method: z.enum(["online", "pay_at_club"]),
    p_provider: z.string().nullable(), p_hold_seconds: z.number() }).parse(input);
  try {
    const data = await inTransaction(async (manager) => {
      const facts = z.array(z.object({ name: z.string(), location_name: z.string(), timezone: z.string(), notice: z.number(), now: z.string() }))
        .parse(await manager.query(`SELECT c.name, l.name AS location_name, l.timezone,
          l.customer_cancellation_notice_minutes AS notice, clock_timestamp()::text AS now
          FROM public.courts c JOIN public.locations l ON l.id=c.location_id WHERE c.id=$1`, [value.p_court_id]));
      const context = facts[0];
      if (!context) throw new Error("Checkout fixture court not found.");
      const id = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
      const lifecycle = checkoutPersistence(value.p_payment_method);
      const expires = value.p_payment_method === "online" ? new Date(Date.parse(context.now) + value.p_hold_seconds * 1000).toISOString() : null;
      await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [reservationId,value.p_court_id,value.p_booking_date,value.p_starts_at_minute,value.p_ends_at_minute,lifecycle.reservation_status,expires]);
      await insertBookingRecords(manager, { id,reservation_id:reservationId,account_user_id:value.p_account_user_id,
        customer_name:value.p_customer_name,customer_email:value.p_customer_email,customer_phone:value.p_customer_phone,
        total_amount_minor:value.p_total_amount_minor,currency:value.p_currency,payment_method:value.p_payment_method,
        cancellation_notice_minutes:context.notice,status:lifecycle.booking_status });
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,amount_minor,currency,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[attemptId,id,value.p_payment_method,value.p_provider,value.p_total_amount_minor,value.p_currency,lifecycle.attempt_status,expires]);
      return { booking_id:id,reservation_id:reservationId,payment_attempt_id:attemptId,hold_expires_at:expires,status:lifecycle.booking_status };
    });
    return { data: [data], error: null };
  } catch (error: unknown) {
    return { data: [], error: { code: normalizeDatabaseError(error).sqlState, message: "Fixture persistence failed" } };
  }
}

export async function cleanupBookingFixtures(selection: { bookingIds: string[] } | { reservationIds: string[] } | { courtIds: string[] }) {
  return inTransaction(manager => cleanupBookingEvidence(manager, selection));
}

export async function insertBookingFixture(client: SupabaseClient, input: unknown) {
  assertTestEnvironment();
  if (!client) throw new Error("Missing test fixture client");
  try {
    await inTransaction(manager => insertBookingRecords(manager, input));
    return { error: null };
  } catch(error) {
    return { error: { code: normalizeDatabaseError(error).sqlState, message: "Booking fixture failed" } };
  }
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
