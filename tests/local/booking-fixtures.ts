import type { EntityManager } from "typeorm";
import { z } from "zod";
import { assertTestEnvironment } from "./environment.mjs";

const captureReceiptFixtureSchema = z.strictObject({
  paymentAttemptId: z.uuid(),
  providerPaymentId: z.string().min(1).max(255),
  providerCaptureId: z.string().min(1).max(255),
  amountMinor: z.number().int().positive(),
  currency: z.enum(["EUR", "USD", "GBP", "RON", "CHF"]),
});

export async function insertCaptureReceiptFixture(manager: EntityManager, input: unknown) {
  assertTestEnvironment();
  const value = captureReceiptFixtureSchema.parse(input);
  await manager.query(
    `INSERT INTO public.payment_capture_receipts
      (payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
      VALUES($1,'stripe',$2,$3,$4,$5)`,
    [value.paymentAttemptId, value.providerPaymentId, value.providerCaptureId, value.amountMinor, value.currency],
  );
}

// Controlled deadline fixtures bypass only the immutable proposal UPDATE guard.
// Caller owns a transaction; privileged DDL is rolled back on any failure.
export async function setAdjustmentExpiryFixture(manager: EntityManager, id: string, expiresAt: string) {
  assertTestEnvironment();
  await manager.query("ALTER TABLE public.booking_adjustments DISABLE TRIGGER booking_adjustments_immutable");
  await manager.query(`UPDATE public.booking_adjustments SET expires_at=$2::timestamptz,
    capture_accepted_at=CASE WHEN capture_accepted_at IS NULL THEN NULL
      ELSE least(capture_accepted_at,$2::timestamptz-interval '1 microsecond') END WHERE id=$1`, [id, expiresAt]);
  await manager.query("ALTER TABLE public.booking_adjustments ENABLE TRIGGER booking_adjustments_immutable");
}

// Controlled attempt deadlines model clock-boundary cases without weakening the
// production immutable-request trigger.
export async function setPaymentAttemptExpiryFixture(manager: EntityManager, id: string, expiresAt: string) {
  assertTestEnvironment();
  await manager.query("ALTER TABLE public.payment_attempts DISABLE TRIGGER payment_attempts_immutable");
  await manager.query("UPDATE public.payment_attempts SET expires_at=$2::timestamptz WHERE id=$1", [id, expiresAt]);
  await manager.query("ALTER TABLE public.payment_attempts ENABLE TRIGGER payment_attempts_immutable");
}

// Disposable fixtures must delete evidence explicitly; production FKs never cascade it.
export async function cleanupBookingEvidence(manager: EntityManager, selection: { bookingIds: string[] } | { reservationIds: string[] } | { courtIds: string[] }) {
  assertTestEnvironment();
  // Isolated fixture teardown is privileged, serialized and transaction-scoped.
  // No runtime bypass setting exists for immutable revisions.
  await manager.query("SET CONSTRAINTS ALL DEFERRED");
  await manager.query("ALTER TABLE public.booking_revisions DISABLE TRIGGER booking_revisions_immutable");
  await manager.query("ALTER TABLE public.refund_executions DISABLE TRIGGER refund_executions_immutable");
  await manager.query("ALTER TABLE public.payment_provider_events DISABLE TRIGGER payment_provider_events_immutable");
  await manager.query("ALTER TABLE public.payment_capture_receipts DISABLE TRIGGER payment_capture_receipts_immutable");
  await manager.query("ALTER TABLE public.payment_attempts DISABLE TRIGGER payment_attempts_immutable");
  const predicate = "bookingIds" in selection ? "b.id = ANY($1::uuid[])"
    : "reservationIds" in selection ? "b.reservation_id = ANY($1::uuid[])"
      : "b.reservation_id IN (SELECT id FROM public.court_reservations WHERE court_id = ANY($1::uuid[]))";
  const values = "bookingIds" in selection ? selection.bookingIds : "reservationIds" in selection ? selection.reservationIds : selection.courtIds;
  const ids = z.array(z.object({ id: z.uuid() })).parse(await manager.query(`SELECT b.id FROM public.bookings b WHERE ${predicate}`, [values])).map(row => row.id);
  await manager.query("ALTER TABLE public.booking_financial_exceptions DISABLE TRIGGER booking_financial_exceptions_immutable");
  await manager.query("DELETE FROM public.booking_financial_exceptions WHERE booking_id=ANY($1::uuid[])", [ids]);
  await manager.query("ALTER TABLE public.booking_financial_exceptions ENABLE TRIGGER booking_financial_exceptions_immutable");
  await manager.query("DELETE FROM public.payment_provider_events WHERE attempt_id IN (SELECT id FROM public.payment_attempts WHERE booking_id=ANY($1::uuid[]))", [ids]);
  await manager.query("DELETE FROM public.payment_capture_receipts WHERE payment_attempt_id IN (SELECT id FROM public.payment_attempts WHERE booking_id=ANY($1::uuid[]))", [ids]);
  await manager.query("DELETE FROM public.refund_executions WHERE refund_id IN (SELECT id FROM public.payment_refunds WHERE booking_id=ANY($1::uuid[]))", [ids]);
  await manager.query("DELETE FROM public.payment_refunds WHERE booking_id=ANY($1::uuid[])", [ids]);
  await manager.query("DELETE FROM public.payment_attempts WHERE booking_id=ANY($1::uuid[])", [ids]);
  await manager.query("DELETE FROM public.court_reservations WHERE adjustment_id IN (SELECT id FROM public.booking_adjustments WHERE booking_id=ANY($1::uuid[]))", [ids]);
  await manager.query("DELETE FROM public.booking_adjustments WHERE booking_id=ANY($1::uuid[])", [ids]);
  await manager.query("DELETE FROM public.booking_revisions WHERE booking_id=ANY($1::uuid[])", [ids]);
  await manager.query("DELETE FROM public.bookings WHERE id=ANY($1::uuid[])", [ids]);
  await manager.query("SET CONSTRAINTS ALL IMMEDIATE");
  await manager.query("ALTER TABLE public.booking_revisions ENABLE TRIGGER booking_revisions_immutable");
  await manager.query("ALTER TABLE public.refund_executions ENABLE TRIGGER refund_executions_immutable");
  await manager.query("ALTER TABLE public.payment_provider_events ENABLE TRIGGER payment_provider_events_immutable");
  await manager.query("ALTER TABLE public.payment_capture_receipts ENABLE TRIGGER payment_capture_receipts_immutable");
  await manager.query("ALTER TABLE public.payment_attempts ENABLE TRIGGER payment_attempts_immutable");
}

// Synthetic contract fixtures: these facts are not application pricing decisions.
// Call inside a test transaction; no legacy columns or backfills are installed.
export async function insertBookingRecords(manager: EntityManager, input: unknown) {
  const { randomUUID } = await import("node:crypto");
  assertTestEnvironment();
  const schema = z.object({ id: z.uuid().optional(), reservation_id: z.uuid(), account_user_id: z.uuid().nullable().optional(),
    customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(), total_amount_minor: z.number().int(),
    currency: z.string(), payment_method: z.enum(["online", "pay_at_club"]).nullable().optional(),
    cancellation_notice_minutes: z.number().int(), status: z.enum(["confirmed", "pending_payment", "cancelled", "expired", "failed"]).optional(),
    created_at: z.string().optional(), updated_at: z.string().optional() });
  const values = z.array(schema).parse(Array.isArray(input) ? input : [input]);
  for (const value of values) {
    const id = value.id ?? randomUUID(), revisionId = randomUUID();
    const [resource] = z.array(z.object({ location_id: z.uuid(), court_id: z.uuid(), location_name: z.string(), court_name: z.string(),
      timezone: z.string(), booking_date: z.string(), starts_at_minute: z.number(), ends_at_minute: z.number(), cancelled_by_user_id: z.uuid().nullable() }))
      .parse(await manager.query(`SELECT c.location_id,r.court_id,l.name AS location_name,c.name AS court_name,l.timezone,
        r.booking_date::text,r.starts_at_minute,r.ends_at_minute,r.cancelled_by_user_id
        FROM public.court_reservations r JOIN public.courts c ON c.id=r.court_id JOIN public.locations l ON l.id=c.location_id WHERE r.id=$1`, [value.reservation_id]));
    if (!resource) throw new Error("Booking fixture reservation missing");
    const state = value.status === "pending_payment" || value.status === "failed" || value.status === "expired" ? "pending_payment" : "confirmed";
    await manager.query(`INSERT INTO public.bookings(id,reservation_id,account_user_id,status,current_revision_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),coalesce($7::timestamptz,now()))`,
      [id,value.reservation_id,value.account_user_id ?? null,value.status ?? "confirmed",revisionId,value.created_at ?? null,value.updated_at ?? null]);
    const times = Array.from({length:(resource.ends_at_minute-resource.starts_at_minute)/30},(_,i)=>resource.starts_at_minute+i*30);
    const rate = Math.floor(value.total_amount_minor*2/times.length), remainder = value.total_amount_minor*2-rate*times.length;
    const evidence = {version:1,rounding:"half-hour-sum-round",courtState:"outdoor",slots:times.map((minute,i)=>({minute,ruleId:randomUUID(),ruleSetId:randomUUID(),hourlyMinor:rate+(i<remainder ? 1 : 0),startsOn:null,endsOn:null}))};
    await manager.query(`INSERT INTO public.booking_revisions(id,booking_id,revision_number,previous_revision_id,operation_key,intent_hash,kind,booking_state,
      location_id,court_id,location_name,court_name,timezone,booking_date,starts_at_minute,ends_at_minute,
      customer_name,customer_email,customer_phone,total_amount_minor,currency,payment_method,cancellation_notice_minutes,actor_user_id,actor_scope,recorded_at,pricing_evidence)
      VALUES($1,$2,1,NULL,'created','fixture','created',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,coalesce($21::timestamptz,now()),$22)`,
      [revisionId,id,state,resource.location_id,resource.court_id,resource.location_name,resource.court_name,resource.timezone,resource.booking_date,
        resource.starts_at_minute,resource.ends_at_minute,value.customer_name,value.customer_email,value.customer_phone,value.total_amount_minor,value.currency,
        value.payment_method ?? "pay_at_club",value.cancellation_notice_minutes,value.account_user_id ?? null,value.account_user_id ? "customer":"guest",value.created_at ?? null,JSON.stringify(evidence)]);
    if (value.status === "cancelled") {
      const finalId = randomUUID();
      await manager.query(`INSERT INTO public.booking_revisions SELECT $1,booking_id,2,id,'cancellation','fixture','cancelled',
        'cancelled',location_id,court_id,location_name,court_name,timezone,booking_date,starts_at_minute,ends_at_minute,
        customer_name,customer_email,customer_phone,total_amount_minor,currency,payment_method,cancellation_notice_minutes,
        $3,'admin',now(),NULL,'admin_cancelled',pricing_evidence,NULL FROM public.booking_revisions WHERE id=$2`, [finalId,revisionId,resource.cancelled_by_user_id]);
      await manager.query("UPDATE public.bookings SET current_revision_id=$1 WHERE id=$2",[finalId,id]);
    }
  }
}
