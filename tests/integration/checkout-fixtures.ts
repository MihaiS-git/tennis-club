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
      await manager.query(`INSERT INTO public.bookings(id,reservation_id,account_user_id,customer_name,customer_email,customer_phone,
        total_amount_minor,currency,payment_method,cancellation_notice_minutes,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id,reservationId,value.p_account_user_id,value.p_customer_name,value.p_customer_email,value.p_customer_phone,
          value.p_total_amount_minor,value.p_currency,value.p_payment_method,context.notice,lifecycle.booking_status]);
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,amount_minor,currency,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[attemptId,id,value.p_payment_method,value.p_provider,value.p_total_amount_minor,value.p_currency,lifecycle.attempt_status,expires]);
      return { booking_id:id,reservation_id:reservationId,payment_attempt_id:attemptId,hold_expires_at:expires,status:lifecycle.booking_status };
    });
    return { data: [data], error: null };
  } catch (error: unknown) {
    return { data: [], error: { code: normalizeDatabaseError(error).sqlState, message: "Fixture persistence failed" } };
  }
}
