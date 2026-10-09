import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { paymentProviderSchema } from "@/lib/payments/domain";
import type { PaymentProvider } from "@/lib/payments/domain";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";

export async function findSelectedPaymentProvider(manager: EntityManager, lock = false) {
  const rows: unknown = await manager.query(
    `SELECT active_provider FROM public.payment_provider_settings WHERE id = true${lock ? " FOR SHARE" : ""}`,
  );
  return z.array(z.object({ active_provider: paymentProviderSchema.nullable() })).length(1).parse(rows)[0].active_provider;
}

export type CheckoutAttemptFields = Pick<PaymentAttemptEntity,
  "id" | "bookingId" | "method" | "provider" | "amountMinor" | "currency" | "status"
> & { expiresAt: string | null };

export async function insertCheckoutAttempt(manager: EntityManager, input: CheckoutAttemptFields) {
  // Keep PostgreSQL's full-precision deadline shared with the reservation.
  await manager.query(
    `INSERT INTO public.payment_attempts
     (id,booking_id,method,provider,amount_minor,currency,status,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
    [input.id, input.bookingId, input.method, input.provider, input.amountMinor, input.currency, input.status, input.expiresAt],
  );
}

export async function findCheckoutAttempt(manager: EntityManager, id: string, tokenHash?: string) {
  return manager.getRepository(PaymentAttemptEntity).findOne({
    where: { id, ...(tokenHash === undefined ? {} : { checkoutTokenHash: tokenHash }) },
    select: { id: true, bookingId: true, method: true, provider: true, providerPaymentId: true,
      amountMinor: true, currency: true, status: true, expiresAt: true, checkoutTokenHash: true },
  });
}

export async function lockCheckoutAttempt(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentAttemptEntity).createQueryBuilder("attempt")
    .where("attempt.id = :id", { id }).setLock("pessimistic_write").getOne();
}

export async function attachCheckoutPayment(manager: EntityManager, input: {
  attemptId: string; bookingId: string; provider: PaymentProvider; providerPaymentId: string; tokenHash: string;
}): Promise<boolean> {
  const rows: unknown = await manager.query(
    `WITH attached AS (UPDATE public.payment_attempts SET provider_payment_id=$4, checkout_token_hash=$5,updated_at=now()
     WHERE id=$1 AND booking_id=$2 AND method='online' AND provider=$3
       AND (provider_payment_id IS NULL OR provider_payment_id=$4) AND checkout_token_hash IS NULL
     RETURNING id) SELECT id FROM attached`,
    [input.attemptId, input.bookingId, input.provider, input.providerPaymentId, input.tokenHash],
  );
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows).length === 1;
}

const refundPaymentSchema = z.object({ id: z.uuid(), provider: z.literal("stripe"),
  provider_payment_id: z.string(), amount_minor: z.number().int(), currency: z.string() });

export async function findAndLockEarliestSucceededStripeAttempt(manager: EntityManager, bookingId: string) {
  const rows: unknown = await manager.query(
    `SELECT id,provider,provider_payment_id,amount_minor,currency FROM public.payment_attempts
     WHERE booking_id=$1 AND status='succeeded' AND method='online' AND provider='stripe'
     ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [bookingId]);
  return z.array(refundPaymentSchema).max(1).parse(rows)[0] ?? null;
}

export async function findAndLockRefundByBooking(manager: EntityManager, bookingId: string) {
  const rows: unknown = await manager.query(
    "SELECT id FROM public.payment_refunds WHERE booking_id=$1 FOR UPDATE", [bookingId]);
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

export async function insertBookingRefundRequest(manager: EntityManager, bookingId: string, actorId: string,
  payment: z.infer<typeof refundPaymentSchema>) {
  const rows: unknown = await manager.query(
    `INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,
     amount_minor,currency,requested_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [bookingId,payment.id,payment.provider,payment.provider_payment_id,payment.amount_minor,payment.currency,actorId]);
  return z.array(z.object({ id: z.uuid() })).length(1).parse(rows)[0].id;
}


const settlementResultSchema = z.enum(["succeeded", "pending", "failed", "cancelled", "expired", "unavailable", "amount_mismatch"]);
const providerReceiptSchema = z.object({
  provider: paymentProviderSchema, event_id: z.string(), attempt_id: z.uuid(),
  provider_payment_id: z.string(), outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]),
  amount_minor: z.number().int(), currency: z.string(), settlement_result: settlementResultSchema,
  reconciliation_required: z.boolean(),
});
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export async function findSettlementBookingId(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query("SELECT booking_id FROM public.payment_attempts WHERE id=$1", [attemptId]);
  return z.array(z.object({ booking_id: z.uuid() })).max(1).parse(rows)[0]?.booking_id ?? null;
}

export async function lockSettlementAttempt(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    `SELECT id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,
     replace((expires_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS expires_at
     FROM public.payment_attempts WHERE id=$1 FOR UPDATE`, [id]);
  return z.array(z.object({ id: z.uuid(), booking_id: z.uuid(), method: z.enum(["online", "pay_at_club"]),
    provider: paymentProviderSchema.nullable(), provider_payment_id: z.string().nullable(),
    amount_minor: z.number().int(), currency: z.string(),
    status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired", "due"]),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
  })).max(1).parse(rows)[0] ?? null;
}

// A deadline predicate is a persistence fence, not a lifecycle decision. If it
// fails, TypeScript re-evaluates expiry before making any aggregate writes.
export async function updateSettlementAttempt(manager: EntityManager, id: string, input: {
  status: string; providerPaymentId: string; deadline: string | null;
}): Promise<boolean> {
  const rows: unknown = await manager.query(
    `WITH changed AS (UPDATE public.payment_attempts
     SET status=$2,provider_payment_id=$3,completed_at=clock_timestamp(),updated_at=now()
     WHERE id=$1 AND ($4::timestamptz IS NULL OR clock_timestamp()<$4::timestamptz)
     RETURNING id) SELECT id FROM changed`, [id,input.status,input.providerPaymentId,input.deadline]);
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows).length === 1;
}

export async function findProviderEventReceipt(manager: EntityManager, provider: PaymentProvider, eventId: string) {
  const rows: unknown = await manager.query(
    `SELECT provider,event_id,attempt_id,provider_payment_id,outcome,amount_minor,currency,
     settlement_result,reconciliation_required FROM public.payment_provider_events
     WHERE provider=$1 AND event_id=$2`, [provider,eventId]);
  return z.array(providerReceiptSchema).max(1).parse(rows)[0] ?? null;
}

export async function insertProviderEventReceipt(manager: EntityManager, receipt: ProviderReceipt): Promise<boolean> {
  const rows: unknown = await manager.query(
    `INSERT INTO public.payment_provider_events(provider,event_id,attempt_id,provider_payment_id,outcome,
     amount_minor,currency,settlement_result,reconciliation_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(provider,event_id) DO NOTHING RETURNING event_id`,
    [receipt.provider,receipt.event_id,receipt.attempt_id,receipt.provider_payment_id,receipt.outcome,
      receipt.amount_minor,receipt.currency,receipt.settlement_result,receipt.reconciliation_required]);
  return z.array(z.object({ event_id: z.string() })).max(1).parse(rows).length === 1;
}

// Phase 8 projections deliberately avoid entity timestamp hydration.
const processingRefundSchema = z.object({
  id: z.uuid(), booking_id: z.uuid(), payment_attempt_id: z.uuid(), provider: z.literal("stripe"),
  provider_payment_id: z.string().min(1), provider_refund_id: z.string().nullable(),
  amount_minor: z.number().int().positive(), currency: z.string().length(3),
  status: z.enum(["pending", "pending_retry", "succeeded", "failed"]),
  created_at: z.iso.datetime({ offset: true }),
  admin_lease_token: z.uuid().nullable(), admin_lease_actor_id: z.uuid().nullable(),
  admin_lease_until: z.iso.datetime({ offset: true }).nullable(), lease_busy: z.boolean().nullable(),
});
export type ProcessingRefund = z.infer<typeof processingRefundSchema>;
const processingRefundProjection = `id,booking_id,payment_attempt_id,provider,provider_payment_id,
  provider_refund_id,amount_minor,currency,status,admin_lease_token,admin_lease_actor_id,
  replace((created_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS created_at,
  replace((admin_lease_until AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS admin_lease_until,
  admin_lease_until > clock_timestamp() AS lease_busy`;

export async function discoverRefundBooking(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    "SELECT booking_id,payment_attempt_id FROM public.payment_refunds WHERE id=$1", [id]);
  return z.array(z.object({ booking_id: z.uuid(), payment_attempt_id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

export async function discoverEventAttempt(manager: EntityManager, eventId: string) {
  const rows: unknown = await manager.query(
    "SELECT attempt_id FROM public.payment_provider_events WHERE provider='stripe' AND event_id=$1", [eventId]);
  return z.array(z.object({ attempt_id: z.uuid() })).max(1).parse(rows)[0]?.attempt_id ?? null;
}

export async function lockRefundForProcessing(manager: EntityManager, target: { id: string } | { bookingId: string }) {
  const byId = "id" in target;
  const rows: unknown = await manager.query(
    `SELECT ${processingRefundProjection} FROM public.payment_refunds WHERE ${byId ? "id" : "booking_id"}=$1 FOR UPDATE`,
    [byId ? target.id : target.bookingId]);
  return z.array(processingRefundSchema).max(1).parse(rows)[0] ?? null;
}

export async function lockRefundEventsForAttempt(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(
    `SELECT provider,event_id,attempt_id,provider_payment_id,outcome,amount_minor,currency,
     settlement_result,reconciliation_required,
     replace((resolved_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS resolved_at,
     resolved_by_user_id FROM public.payment_provider_events WHERE attempt_id=$1
     ORDER BY provider,event_id FOR UPDATE`, [attemptId]);
  return z.array(providerReceiptSchema.extend({ resolved_at: z.string().nullable(), resolved_by_user_id: z.uuid().nullable() })).parse(rows);
}

function requireOneRefund(rows: unknown) {
  z.array(z.object({ id: z.uuid() })).length(1).parse(rows);
}

export async function writeRefundLease(manager: EntityManager, id: string, token: string, actorId: string) {
  requireOneRefund(await manager.query(
    `WITH changed AS (UPDATE public.payment_refunds SET admin_lease_token=$2,admin_lease_actor_id=$3,
     admin_lease_until=clock_timestamp()+interval '5 minutes',updated_at=now() WHERE id=$1 RETURNING id) SELECT id FROM changed`, [id,token,actorId]));
}

export async function writeRefundResult(manager: EntityManager, id: string, input: {
  status: ProcessingRefund["status"]; providerRefundId: string | null; lastError: string | null; clearLease: boolean;
}) {
  requireOneRefund(await manager.query(
    `WITH changed AS (UPDATE public.payment_refunds SET status=$2,provider_refund_id=coalesce($3,provider_refund_id),last_error=$4,updated_at=now()
     ${input.clearLease ? ",admin_lease_token=NULL,admin_lease_until=NULL,admin_lease_actor_id=NULL" : ""}
     WHERE id=$1 RETURNING id) SELECT id FROM changed`, [id,input.status,input.providerRefundId,input.lastError]));
}

export async function writeRefundEventResolution(manager: EntityManager,
  events: readonly { provider: string; event_id: string }[], attemptId: string, actorId: string) {
  for (const event of events) {
    const rows: unknown = await manager.query(
      `WITH changed AS (UPDATE public.payment_provider_events SET reconciliation_required=false,
       resolved_at=clock_timestamp(),resolved_by_user_id=$4
       WHERE provider=$1 AND event_id=$2 AND attempt_id=$3 AND reconciliation_required RETURNING event_id) SELECT event_id FROM changed`,
      [event.provider,event.event_id,attemptId,actorId]);
    z.array(z.object({ event_id: z.string() })).length(1).parse(rows);
  }
}

export async function listAdminTransactionProjection(manager: EntityManager, query: {
  page: number; status: string; provider: string; method: string; attention: boolean;
  search: string; sort: string; direction: string; bookingId: string | null;
  attentionRefundStatuses: readonly string[];
}): Promise<unknown> {
  const rows: unknown = await manager.query(`with transactions as (
    select b.id as booking_id, b.reservation_id, b.customer_name, b.customer_email,
      coalesce(p.amount_minor, b.total_amount_minor) as amount_minor,
      coalesce(p.currency, b.currency) as currency,
      coalesce(p.method, b.payment_method) as method, p.provider, p.status as payment_status,
      p.provider_payment_id, coalesce(p.created_at, b.created_at) as created_at,
      coalesce(p.updated_at, b.updated_at) as updated_at,
      b.status::text as booking_status,r.status::text as reservation_status,r.booking_date, r.starts_at_minute, r.ends_at_minute, c.name as court_name,
      l.name as location_name, l.timezone as location_timezone,
      case when f.id is null then null else jsonb_build_object(
        'id',f.id,'amount_minor',f.amount_minor,'currency',f.currency,'status',f.status,
        'provider_refund_id',f.provider_refund_id,'requested_by_user_id',f.requested_by_user_id,
        'requested_by_name',nullif(concat_ws(' ',u.first_name,u.last_name),''),
        'payment_attempt_id',f.payment_attempt_id,'created_at',f.created_at,'updated_at',f.updated_at,'last_error',f.last_error) end as refund,
      coalesce(e.reconciliation, '[]'::jsonb) as reconciliation,
      (coalesce(f.status = any($10::text[]), false) or ($11::boolean and coalesce(e.required,false))) as matches_attention
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.payment_refunds f on f.booking_id = b.id
    left join public.users u on u.id = f.requested_by_user_id
    left join lateral (
      select a.* from public.payment_attempts a where a.booking_id = b.id
      order by (a.id = f.payment_attempt_id) desc nulls last,
        (a.status = 'succeeded') desc,
        case when a.status = 'succeeded' then a.created_at end asc,
        a.created_at desc, a.id limit 1
    ) p on true
    left join lateral (
      select bool_or(ev.reconciliation_required) as required, jsonb_agg(jsonb_build_object(
        'event_id',ev.event_id,'attempt_id',ev.attempt_id,'provider',ev.provider,'reconciliation_required',ev.reconciliation_required,
        'resolved_at',ev.resolved_at,'resolved_by_user_id',ev.resolved_by_user_id,
        'attempt',to_jsonb(a),'amount_minor',ev.amount_minor,'currency',ev.currency,'provider_payment_id',ev.provider_payment_id,
        'settlement_result', ev.settlement_result,
        'outcome', ev.outcome, 'received_at', ev.received_at) order by ev.received_at, ev.event_id) as reconciliation
      from public.payment_provider_events ev join public.payment_attempts a on a.id = ev.attempt_id
      where a.booking_id = b.id and (ev.reconciliation_required or ev.resolved_at is not null)
      having count(*) > 0
    ) e on true
  ), filtered as materialized (
    select * from transactions t where ($9::uuid is null or t.booking_id = $9::uuid) and ($2::text = 'all' or t.payment_status = $2::text)
      and ($3::text = 'all' or t.provider = $3::text)
      and ($4::text = 'all' or t.method = $4::text)
      and (not $5::boolean or t.matches_attention)
      -- Literal substring matching: %, _ and other input are not SQL patterns.
      and ($6::text = '' or strpos(lower(t.customer_name),lower($6::text)) > 0
        or strpos(lower(t.customer_email),lower($6::text)) > 0
        or strpos(t.booking_id::text,lower($6::text)) > 0
        or strpos(lower(coalesce(t.provider_payment_id,'')),lower($6::text)) > 0)
  ), stats as (
    select count(*)::integer as total, greatest(1,ceil(count(*) / 20.0)::integer) as total_pages from filtered
  ), ordered as (
    select t.*, row_number() over (order by
      case when $7::text = 'date' and $8::text = 'asc' then t.created_at end asc,
      case when $7::text = 'date' and $8::text = 'desc' then t.created_at end desc,
      case when $7::text = 'amount' and $8::text = 'asc' then t.amount_minor end asc,
      case when $7::text = 'amount' and $8::text = 'desc' then t.amount_minor end desc,
      case when $7::text = 'payment' and $8::text = 'asc' then t.payment_status end asc nulls last,
      case when $7::text = 'payment' and $8::text = 'desc' then t.payment_status end desc nulls last,
      t.booking_id asc) as position from filtered t
  )
  select jsonb_build_object('total',s.total,'totalPages',s.total_pages,'page',least($1::integer,s.total_pages),
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'position' - 'matches_attention' order by o.position)
      from ordered o where o.position > (least($1::integer,s.total_pages)-1)*20
        and o.position <= least($1::integer,s.total_pages)*20),'[]'::jsonb)) AS result from stats s;`,
    [query.page,query.status,query.provider,query.method,query.attention,query.search,query.sort,
      query.direction,query.bookingId,query.attentionRefundStatuses,true]);
  return z.array(z.object({ result: z.unknown() })).length(1).parse(rows)[0].result;
}

export async function lockProviderSelection(manager: EntityManager) {
  const rows: unknown = await manager.query(
    "SELECT active_provider FROM public.payment_provider_settings WHERE id=true FOR UPDATE");
  return z.array(z.object({ active_provider: paymentProviderSchema.nullable() })).length(1).parse(rows)[0].active_provider;
}

export async function writeProviderSelection(manager: EntityManager, previous: PaymentProvider | null,
  provider: PaymentProvider | null, actorId: string): Promise<void> {
  await manager.query(`UPDATE public.payment_provider_settings SET active_provider=$1,
    updated_by_user_id=$2,updated_at=clock_timestamp() WHERE id=true`, [provider,actorId]);
  await manager.query(`INSERT INTO public.payment_provider_changes(previous_provider,active_provider,changed_by_user_id)
    VALUES($1,$2,$3)`, [previous,provider,actorId]);
}


export type HoldExpiryScope = { courtId?: string; locationId?: string };
export async function discoverExpiredHoldLocations(manager: EntityManager, scope: HoldExpiryScope, limit: number) {
  const rows: unknown = await manager.query(`SELECT DISTINCT c.location_id
    FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.courts c ON c.id=r.court_id
    WHERE b.status='pending_payment' AND r.status='held' AND r.hold_expires_at<=clock_timestamp()
      AND ($1::uuid IS NULL OR r.court_id=$1) AND ($2::uuid IS NULL OR c.location_id=$2)
    ORDER BY c.location_id LIMIT $3`, [scope.courtId ?? null,scope.locationId ?? null,limit]);
  return z.array(z.object({ location_id: z.uuid() })).parse(rows);
}

export async function lockHoldExpiryLocation(manager: EntityManager, id: string): Promise<boolean> {
  const rows: unknown = await manager.query("SELECT id FROM public.locations WHERE id=$1 FOR UPDATE SKIP LOCKED", [id]);
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows).length === 1;
}

export async function lockExpiredHoldBookings(manager: EntityManager, locationId: string, input: {
  courtId?: string; excludeReservationId?: string; skipLocked: boolean; limit?: number;
}) {
  const rows: unknown = await manager.query(`SELECT b.id,b.reservation_id FROM public.bookings b
    JOIN public.court_reservations r ON r.id=b.reservation_id JOIN public.courts c ON c.id=r.court_id
    WHERE c.location_id=$1 AND b.status='pending_payment' AND r.status='held'
      AND r.hold_expires_at<=clock_timestamp() AND ($2::uuid IS NULL OR r.court_id=$2)
      AND ($3::uuid IS NULL OR r.id<>$3)
    ORDER BY b.id LIMIT $4 FOR UPDATE OF b${input.skipLocked ? " SKIP LOCKED" : ""}`,
    [locationId,input.courtId ?? null,input.excludeReservationId ?? null,input.limit ?? null]);
  return z.array(z.object({ id: z.uuid(), reservation_id: z.uuid() })).parse(rows);
}

export async function lockHoldExpiryAttempts(manager: EntityManager, bookingId: string, skipLocked: boolean) {
  const rows: unknown = await manager.query(`SELECT id,status,
    (SELECT count(*)::integer FROM public.payment_attempts WHERE booking_id=$1) AS total
    FROM public.payment_attempts WHERE booking_id=$1 ORDER BY id FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`, [bookingId]);
  return z.array(z.object({ id: z.uuid(), status: z.enum(["pending","succeeded","failed","cancelled","expired","due"]),
    total: z.number().int() })).parse(rows);
}

export async function expirePendingAttempt(manager: EntityManager, id: string) {
  await manager.query(`UPDATE public.payment_attempts SET status='expired',completed_at=clock_timestamp(),updated_at=now()
    WHERE id=$1 AND status='pending'`, [id]);
}

export async function discoverSettlementParent(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(`SELECT p.booking_id,b.reservation_id,c.location_id
    FROM public.payment_attempts p JOIN public.bookings b ON b.id=p.booking_id
    JOIN public.court_reservations r ON r.id=b.reservation_id JOIN public.courts c ON c.id=r.court_id
    WHERE p.id=$1`, [attemptId]);
  return z.array(z.object({ booking_id: z.uuid(), reservation_id: z.uuid(), location_id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

// Refund-only transactions read immutable financial facts without acquiring
// earlier aggregate locks after a refund lock.
export async function findRefundCaptureEvidence(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status
    FROM public.payment_attempts WHERE id=$1`, [attemptId]);
  const payment = z.array(z.object({ id:z.uuid(),booking_id:z.uuid(),method:z.string(),provider:paymentProviderSchema.nullable(),
    provider_payment_id:z.string().nullable(),amount_minor:z.number().int(),currency:z.string(),status:z.string() })).max(1).parse(rows)[0] ?? null;
  const events: unknown = await manager.query(`SELECT provider,event_id,attempt_id,provider_payment_id,outcome,amount_minor,currency,
    settlement_result,reconciliation_required FROM public.payment_provider_events WHERE attempt_id=$1 ORDER BY provider,event_id`, [attemptId]);
  return { payment, events: z.array(providerReceiptSchema).parse(events) };
}

export async function countBookingPaymentAttempts(manager: EntityManager, bookingId: string): Promise<number> {
  const rows: unknown = await manager.query("SELECT count(*)::integer AS total FROM public.payment_attempts WHERE booking_id=$1", [bookingId]);
  return z.array(z.object({ total: z.number().int() })).length(1).parse(rows)[0].total;
}
