import "server-only";

import { In, type EntityManager } from "typeorm";
import { protectedPaymentOccupancy } from "./reservations.repository";
import { z } from "zod";
import { paymentProviderSchema, checkoutCaptureGraceSeconds, unconfirmedRefundMinutes } from "@/lib/payments/domain";
import type { PaymentProvider } from "@/lib/payments/domain";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";
import { RefundExecutionEntity } from "../entities/refund-execution.entity";
import { PaymentRefundEntity } from "../entities/payment-refund.entity";
import { BookingRevisionEntity } from "../entities/booking-revision.entity";
import { BookingAdjustmentEntity } from "../entities/booking-adjustment.entity";
import { PaymentCaptureReceiptEntity } from "../entities/payment-capture-receipt.entity";

// An uncollected club debt follows the current booking price. Captured online
// transactions remain immutable and are never included in this update.
export async function findCheckoutRefund(manager: EntityManager, attemptId: string) {
  return manager.getRepository(PaymentRefundEntity).findOne({
    where: { paymentAttemptId: attemptId }, select: { id: true, status: true },
  });
}

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
      amountMinor: true, currency: true, status: true, expiresAt: true, checkoutTokenHash: true, adjustmentId: true },
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

export async function findAndLockRefundByBooking(manager: EntityManager, bookingId: string, attemptId?: string) {
  const rows: unknown = await manager.query(
    "SELECT id FROM public.payment_refunds WHERE booking_id=$1 AND operation_key='cancellation' AND ($2::uuid IS NULL OR payment_attempt_id=$2) ORDER BY created_at,id LIMIT 1 FOR UPDATE", [bookingId, attemptId ?? null]);
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

const settlementResultSchema = z.enum(["succeeded", "pending", "failed", "cancelled", "expired", "unavailable", "amount_mismatch"]);
const providerReceiptSchema = z.object({
  provider: paymentProviderSchema, event_id: z.string(), attempt_id: z.uuid(),
  capture_receipt_id: z.uuid().nullable(), provider_capture_id: z.string().nullable(),
  provider_payment_id: z.string(), outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]),
  amount_minor: z.number().int(), currency: z.string(), settlement_result: settlementResultSchema,
  reconciliation_required: z.boolean(),
});
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export async function lockSettlementAttempt(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    `SELECT id,booking_id,adjustment_id,method,provider,provider_payment_id,amount_minor,currency,status,
     replace((expires_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS expires_at,
     checkout_token_hash IS NOT NULL AS checkout_capability
     FROM public.payment_attempts WHERE id=$1 FOR UPDATE`, [id]);
  return z.array(z.object({ id: z.uuid(), booking_id: z.uuid(), adjustment_id: z.uuid().nullable().optional(), method: z.enum(["online", "pay_at_club"]),
    provider: paymentProviderSchema.nullable(), provider_payment_id: z.string().nullable(),
    amount_minor: z.number().int(), currency: z.string(),
    status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired", "due"]),
    expires_at: z.iso.datetime({ offset: true }).nullable(), checkout_capability: z.boolean(),
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
    `SELECT e.provider,e.event_id,e.attempt_id,e.capture_receipt_id,c.provider_capture_id,
     e.provider_payment_id,e.outcome,e.amount_minor,e.currency,e.settlement_result,e.reconciliation_required
     FROM public.payment_provider_events e LEFT JOIN public.payment_capture_receipts c ON c.id=e.capture_receipt_id
     WHERE e.provider=$1 AND e.event_id=$2`, [provider,eventId]);
  return z.array(providerReceiptSchema).max(1).parse(rows)[0] ?? null;
}

export async function insertProviderEventReceipt(manager: EntityManager, receipt: ProviderReceipt): Promise<boolean> {
  const rows: unknown = await manager.query(
    `INSERT INTO public.payment_provider_events(provider,event_id,attempt_id,capture_receipt_id,provider_payment_id,outcome,
     amount_minor,currency,settlement_result,reconciliation_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(provider,event_id) DO NOTHING RETURNING event_id`,
    [receipt.provider,receipt.event_id,receipt.attempt_id,receipt.capture_receipt_id,receipt.provider_payment_id,receipt.outcome,
      receipt.amount_minor,receipt.currency,receipt.settlement_result,receipt.reconciliation_required]);
  return z.array(z.object({ event_id: z.string() })).max(1).parse(rows).length === 1;
}

const processingRefundSchema = z.object({
  id: z.uuid(), booking_id: z.uuid(), payment_attempt_id: z.uuid(), operation_key: z.string(), provider: z.literal("stripe"),
  provider_payment_id: z.string().min(1), amount_minor: z.number().int().positive(),
  captured_amount_minor: z.number().int().positive(), currency: z.string().length(3),
  status: z.enum(["pending", "pending_retry", "succeeded", "failed", "voided"]),
  adjustment_id: z.uuid().nullable(), reason: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type ProcessingRefund = z.infer<typeof processingRefundSchema>;
const processingRefundProjection = `id,booking_id,payment_attempt_id,operation_key,provider,provider_payment_id,
  amount_minor,captured_amount_minor,currency,status,adjustment_id,reason,
  replace((created_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS created_at`;

export async function discoverRefundBooking(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    "SELECT booking_id,payment_attempt_id FROM public.payment_refunds WHERE id=$1", [id]);
  return z.array(z.object({ booking_id: z.uuid(), payment_attempt_id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

export async function lockRefundForProcessing(manager: EntityManager, target: { id: string }) {
  const rows: unknown = await manager.query(
    `SELECT ${processingRefundProjection} FROM public.payment_refunds WHERE id=$1 FOR UPDATE`,
    [target.id]);
  return z.array(processingRefundSchema).max(1).parse(rows)[0] ?? null;
}

export async function lockRefundEventsForAttempt(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(
    `SELECT e.provider,e.event_id,e.attempt_id,e.capture_receipt_id,c.provider_capture_id,
     e.provider_payment_id,e.outcome,e.amount_minor,e.currency,e.settlement_result,e.reconciliation_required,
     replace((e.resolved_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS resolved_at,
     e.resolved_by_user_id FROM public.payment_provider_events e
     LEFT JOIN public.payment_capture_receipts c ON c.id=e.capture_receipt_id WHERE e.attempt_id=$1
     ORDER BY e.provider,e.event_id FOR UPDATE OF e`, [attemptId]);
  return z.array(providerReceiptSchema.extend({ resolved_at: z.string().nullable(), resolved_by_user_id: z.uuid().nullable() })).parse(rows);
}

function requireOneRefund(rows: unknown) {
  z.array(z.object({ id: z.uuid() })).length(1).parse(rows);
}

export async function writeRefundStatus(manager: EntityManager, id: string, status: ProcessingRefund["status"]) {
  requireOneRefund(await manager.query(
    `WITH changed AS (UPDATE public.payment_refunds SET status=$2,updated_at=now()
      WHERE id=$1 AND status IS DISTINCT FROM $2 RETURNING id) SELECT id FROM public.payment_refunds WHERE id=$1`, [id,status]));
}

export async function writeRefundEventResolution(manager: EntityManager,
  events: readonly { provider: string; event_id: string }[], attemptId: string, actorId: string | null) {
  for (const event of events) {
    const rows: unknown = await manager.query(
      `WITH changed AS (UPDATE public.payment_provider_events SET reconciliation_required=false,
       resolved_at=clock_timestamp(),resolved_by_user_id=$4
       WHERE provider=$1 AND event_id=$2 AND attempt_id=$3 AND reconciliation_required RETURNING event_id) SELECT event_id FROM changed`,
      [event.provider,event.event_id,attemptId,actorId]);
    z.array(z.object({ event_id: z.string() })).length(1).parse(rows);
  }
}

// A capture receipt is terminal provider evidence: the authorization is no
// longer unresolved, whatever the attempt status. Any obligation the capture
// leaves (late-capture compensation, review of an unapplied payment) is carried
// by its refund and by its provider event's reconciliation flag instead.
const uncapturedAttempt = (alias: string) =>
  `NOT EXISTS(SELECT 1 FROM public.payment_capture_receipts c WHERE c.payment_attempt_id=${alias}.id)`;

// Derived attention only: local expiry never proves that Stripe cancelled an
// intent. Accepted or abandoned overdue payments remain visible until checked.
const paymentCheckRequired = `coalesce(op.kind='payment' AND p.provider='stripe' AND p.provider_payment_id IS NOT NULL
  AND p.status IN ('pending','expired','failed')
  AND p.expires_at+make_interval(secs => ${checkoutCaptureGraceSeconds})<=clock_timestamp()
  AND ${uncapturedAttempt("p")},false)`;

export async function listAdminTransactionProjection(manager: EntityManager, query: {
  page: number; status: string; provider: string; method: string; attention: boolean;
  search: string; sort: string; direction: string; bookingId: string | null;
  attentionRefundStatuses: readonly string[]; unconfirmedRefundMinutes?: number;
  transaction?: { kind: "payment" | "refund" | "booking"; id: string };
}): Promise<unknown> {
  const rows: unknown = await manager.query(`with operations as (
    select 'payment'::text as kind, p.id, p.booking_id, p.id as attempt_id, null::uuid as refund_id,
      p.adjustment_id, p.amount_minor, p.currency, p.method, p.provider, p.status, p.provider_payment_id,
      p.created_at, p.updated_at, initial.id as context_revision_id, null::uuid as base_revision_id,
      null::uuid as applied_revision_id, null::text as adjustment_status
    from public.payment_attempts p
    join public.booking_revisions initial on initial.booking_id=p.booking_id and initial.revision_number=1
    where p.adjustment_id is null
    union all
    select 'payment', p.id, p.booking_id, p.id, null, p.adjustment_id, p.amount_minor, p.currency,
      p.method, p.provider, p.status, p.provider_payment_id, p.created_at, p.updated_at,
      coalesce(applied.id,a.base_revision_id), a.base_revision_id, applied.id, a.status
    from public.payment_attempts p
    join public.booking_adjustments a on a.id=p.adjustment_id and a.booking_id=p.booking_id
    left join public.booking_revisions applied on applied.adjustment_id=a.id and applied.booking_id=a.booking_id
    union all
    select 'refund', f.id, f.booking_id, f.payment_attempt_id, f.id, f.adjustment_id,
      f.amount_minor, f.currency, 'online', f.provider, f.status, f.provider_payment_id,
      f.created_at, f.updated_at, f.context_revision_id, a.base_revision_id, applied.id, a.status
    from public.payment_refunds f
    left join public.booking_adjustments a on a.id=f.adjustment_id and a.booking_id=f.booking_id
    left join public.booking_revisions applied on applied.adjustment_id=a.id and applied.booking_id=a.booking_id
    union all
    select 'booking', b.id, b.id, null, null, null, initial.total_amount_minor, initial.currency,
      initial.payment_method, null, null, null, b.created_at, b.created_at, initial.id, null, null, null
    from public.checkout_records b
    join public.booking_revisions initial on initial.booking_id=b.id and initial.revision_number=1
    where not exists(select 1 from public.payment_attempts p where p.booking_id=b.id)
  ), candidates as (
    -- Filter before materializing, and keep financial payload construction after pagination.
    select op.*, ${paymentCheckRequired} as payment_check_required,
      (${paymentCheckRequired} or coalesce(f.status = any($10::text[]), false)
        or coalesce(f.status in ('pending','pending_retry') and coalesce(execution.dispatch_initiated_at,execution.first_uncertain_at,execution.created_at,f.created_at)
          < clock_timestamp() - make_interval(mins => $14::integer), false)
        or ($11::boolean and exists(select 1 from public.payment_provider_events ev
          where ev.attempt_id=op.attempt_id and ev.reconciliation_required))) as matches_attention
    from operations op
    join public.checkout_records b on b.id=op.booking_id
    join public.booking_revisions context on context.id=op.context_revision_id and context.booking_id=b.id
    join public.court_reservations r on r.id=b.reservation_id
    left join public.payment_attempts p on p.id=op.attempt_id
    left join public.payment_refunds f on f.id=op.refund_id
    left join lateral (select re.provider_refund_id,re.dispatch_initiated_at,re.first_uncertain_at,re.created_at
      from public.refund_executions re where re.refund_id=f.id order by re.execution_number desc limit 1) execution on true
    where ($9::uuid is null or op.booking_id = $9::uuid) and ($2::text = 'all' or op.status = $2::text)
      and ($12::text is null or (op.kind=$12 and op.id=$13::uuid))
      and ($3::text = 'all' or op.provider = $3::text)
      and ($4::text = 'all' or op.method = $4::text)
      -- Literal substring matching: %, _ and other input are not SQL patterns.
      and ($6::text = '' or strpos(lower(context.customer_name),lower($6::text)) > 0
        or strpos(lower(context.customer_email),lower($6::text)) > 0
        or strpos(op.booking_id::text,lower($6::text)) > 0
        or strpos(op.id::text,lower($6::text)) > 0
        or strpos(lower(coalesce(execution.provider_refund_id,'')),lower($6::text)) > 0
        or strpos(lower(coalesce(op.provider_payment_id,'')),lower($6::text)) > 0)
  ), filtered as materialized (
    select * from candidates t
    -- The default list omits abandoned payment requests that never moved money.
    -- They remain stored, reachable by explicit status filter and exact detail reads.
    where ($12::text is not null or $2::text <> 'all' or t.matches_attention
      or not (t.kind = 'payment' and t.status in ('cancelled','expired'))
      or exists(select 1 from public.payment_capture_receipts c where c.payment_attempt_id=t.attempt_id))
      and (not $5::boolean or t.matches_attention)
  ), stats as (
    select count(*)::integer as total, greatest(1,ceil(count(*) / 20.0)::integer) as total_pages from filtered
  ), ordered as (
    select t.*, row_number() over (order by
      case when $7::text = 'date' and $8::text = 'asc' then t.created_at end asc,
      case when $7::text = 'date' and $8::text = 'desc' then t.created_at end desc,
      case when $7::text = 'amount' and $8::text = 'asc'
        then case when t.kind = 'refund' then -t.amount_minor else t.amount_minor end end asc,
      case when $7::text = 'amount' and $8::text = 'desc'
        then case when t.kind = 'refund' then -t.amount_minor else t.amount_minor end end desc,
      case when $7::text = 'payment' and $8::text = 'asc' then t.status end asc nulls last,
      case when $7::text = 'payment' and $8::text = 'desc' then t.status end desc nulls last,
      t.kind asc, t.id asc) as position from filtered t
  ), page_operations as materialized (
    select o.* from ordered o cross join stats s
    where o.position > (least($1::integer,s.total_pages)-1)*20
      and o.position <= least($1::integer,s.total_pages)*20
  ), transactions as (
    select op.position, op.kind as transaction_kind, op.id as transaction_id, op.attempt_id as payment_attempt_id,
      op.adjustment_id, op.status as transaction_status, op.context_revision_id, op.base_revision_id,
      op.applied_revision_id, op.adjustment_status, confirmation.id as confirmation_revision_id,
      b.current_revision_id,
      coalesce((select sum(rf.amount_minor)::integer from public.payment_refunds rf
        where rf.payment_attempt_id=op.attempt_id and rf.status='succeeded'
          and exists(select 1 from public.refund_executions re where re.refund_id=rf.id
            and re.status='succeeded' and re.terminal_result='succeeded' and re.provider_refund_id is not null
            and re.provider=rf.provider and re.provider_payment_id=rf.provider_payment_id
            and re.amount_minor=rf.amount_minor and re.currency=rf.currency)),0) as refunded_minor,
      b.id as booking_id, exists(select 1 from public.bookings actual where actual.id=b.id) as is_actual_booking, b.reservation_id, b.account_user_id, context.customer_name, context.customer_email, op.amount_minor,
      op.currency, op.method, op.provider, p.status as payment_status,
      op.provider_payment_id, op.created_at, op.updated_at,
      b.status::text as booking_status,r.status::text as reservation_status,
      to_jsonb(f) || jsonb_build_object(
        'requested_by_name',nullif(concat_ws(' ',u.first_name,u.last_name),''),
        'provider_refund_id',execution.provider_refund_id,'last_error',execution.last_error,
        'outstanding_since',coalesce(execution.dispatch_initiated_at,execution.first_uncertain_at,execution.created_at,f.created_at)) as refund,
      coalesce(e.reconciliation, '[]'::jsonb) as reconciliation,
      op.payment_check_required
    from page_operations op
    join public.checkout_records b on b.id=op.booking_id
    join public.booking_revisions context on context.id=op.context_revision_id and context.booking_id=b.id
    join public.court_reservations r on r.id=b.reservation_id
    left join public.payment_attempts p on p.id=op.attempt_id
    left join public.booking_revisions confirmation on confirmation.booking_id=b.id
      and confirmation.operation_key='confirmation' and confirmation.kind='confirmed'
      and op.kind='payment' and op.adjustment_id is null and p.status='succeeded'
    left join public.payment_refunds f on f.id=op.refund_id
    left join public.users u on u.id=f.requested_by_user_id
    -- Dispatch is write-once; first uncertainty may only be observed after an outage.
    -- The latest execution gives a genuinely new attempt its own outstanding age.
    left join lateral (select re.provider_refund_id,re.last_error,re.dispatch_initiated_at,re.first_uncertain_at,re.created_at from public.refund_executions re
      where re.refund_id=f.id order by re.execution_number desc limit 1) execution on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'event_id',ev.event_id,'attempt_id',ev.attempt_id,'provider',ev.provider,'reconciliation_required',ev.reconciliation_required,
        'resolved_at',ev.resolved_at,'resolved_by_user_id',ev.resolved_by_user_id,
        'attempt',to_jsonb(a),'amount_minor',ev.amount_minor,'currency',ev.currency,'provider_payment_id',ev.provider_payment_id,
        'settlement_result', ev.settlement_result,
        'outcome', ev.outcome, 'received_at', ev.received_at) order by ev.received_at, ev.event_id) as reconciliation
      from public.payment_provider_events ev join public.payment_attempts a on a.id = ev.attempt_id
      where a.id = op.attempt_id and (ev.reconciliation_required or ev.resolved_at is not null)
      having count(*) > 0
    ) e on true
  )
  select jsonb_build_object('total',s.total,'totalPages',s.total_pages,'page',least($1::integer,s.total_pages),
    'rows',coalesce((select jsonb_agg(to_jsonb(t) - 'position' order by t.position)
      from transactions t),'[]'::jsonb)) AS result from stats s;`,
    [query.page,query.status,query.provider,query.method,query.attention,query.search,query.sort,
      query.direction,query.bookingId,query.attentionRefundStatuses,true,query.transaction?.kind ?? null,query.transaction?.id ?? null,
      query.unconfirmedRefundMinutes ?? unconfirmedRefundMinutes]);
  return z.array(z.object({ result: z.unknown() })).length(1).parse(rows)[0].result;
}

// In-flight financial work at the booking's contractual location: a payment that may
// still settle, a pending modification, an unfinished refund or an unresolved reconciliation.
// Local expiry/failure does not prove a registered Stripe intent was cancelled;
// a capture receipt does resolve it, leaving only its refund and reconciliation.
// Definitive outcomes, failed refunds and pay-at-club amounts due are history.
// Use only the current revision: rescheduling keeps the location, but Admins can move courts.
export async function locationHasUnresolvedFinancialOperations(manager: EntityManager, locationId: string) {
  const rows: unknown = await manager.query(`WITH located AS (
      SELECT b.id AS booking_id FROM public.checkout_records b
      JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE v.location_id=$1)
    SELECT EXISTS(SELECT 1 FROM public.payment_attempts p JOIN located l ON l.booking_id=p.booking_id
        WHERE (p.status='pending' OR (p.provider='stripe' AND p.provider_payment_id IS NOT NULL AND p.status IN ('expired','failed')))
          AND ${uncapturedAttempt("p")})
      OR EXISTS(SELECT 1 FROM public.booking_adjustments a JOIN located l ON l.booking_id=a.booking_id WHERE a.status='pending')
      OR EXISTS(SELECT 1 FROM public.payment_refunds f JOIN located l ON l.booking_id=f.booking_id WHERE f.status IN ('pending','pending_retry'))
      OR EXISTS(SELECT 1 FROM public.payment_provider_events ev JOIN public.payment_attempts p ON p.id=ev.attempt_id
        JOIN located l ON l.booking_id=p.booking_id WHERE ev.reconciliation_required) AS unresolved`, [locationId]);
  return z.array(z.object({ unresolved: z.boolean() })).length(1).parse(rows)[0].unresolved;
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

// Include previously expired/failed attempts and overdue accepted captures:
// local expiry is not terminal provider evidence. Captured attempts are resolved
// authorizations; their compensation follows the refund recovery path instead.
// Most of the batch is the oldest overdue attempts, so a sweep whose checks
// succeed drains the pool first-in first-out. The rest is sampled from the
// remainder, so attempts Stripe persistently cannot resolve (processing, an
// unreadable intent) cannot permanently starve newer ones behind them.
export async function listOverdueStripeCheckouts(manager: EntityManager, limit: number) {
  const oldest = Math.ceil(limit / 2);
  const rows: unknown = await manager.query(`WITH pool AS (SELECT p.id,p.expires_at FROM public.payment_attempts p
      WHERE p.method='online' AND p.provider='stripe' AND p.provider_payment_id IS NOT NULL
        AND p.status IN ('pending','expired','failed') AND p.expires_at<=clock_timestamp() AND ${uncapturedAttempt("p")}),
    oldest AS (SELECT id,expires_at FROM pool ORDER BY expires_at,id LIMIT $2)
    (SELECT id FROM oldest ORDER BY expires_at,id)
    UNION ALL
    (SELECT id FROM pool WHERE id NOT IN (SELECT id FROM oldest) ORDER BY random() LIMIT $1-$2)`, [limit,oldest]);
  return z.array(z.object({ id: z.uuid() })).parse(rows);
}

export async function discoverExpiredHoldLocations(manager: EntityManager, scope: HoldExpiryScope, limit: number) {
  const rows: unknown = await manager.query(`SELECT DISTINCT c.location_id
    FROM public.checkout_records b LEFT JOIN public.booking_revisions v ON v.id=b.current_revision_id JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.courts c ON c.id=r.court_id
    WHERE ((b.status IN ('pending_payment','cancelled','failed') AND r.status='held' AND r.hold_expires_at<=clock_timestamp() AND NOT ${protectedPaymentOccupancy}) OR EXISTS (SELECT 1 FROM public.booking_adjustments ba WHERE ba.booking_id=b.id AND ba.status IN ('pending','cancelled') AND ba.capture_accepted_at IS NULL AND ba.expires_at<=clock_timestamp() AND EXISTS(SELECT 1 FROM public.payment_attempts pa WHERE pa.adjustment_id=ba.id AND pa.status='pending') AND NOT EXISTS(SELECT 1 FROM public.court_reservations lr WHERE lr.adjustment_id=ba.id AND lr.status='held' AND lr.hold_expires_at>clock_timestamp())))
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
  const rows: unknown = await manager.query(`SELECT b.id,b.reservation_id FROM public.checkout_records b LEFT JOIN public.booking_revisions v ON v.id=b.current_revision_id
    JOIN public.court_reservations r ON r.id=b.reservation_id JOIN public.courts c ON c.id=r.court_id
    WHERE c.location_id=$1 AND b.status IN ('pending_payment','cancelled','failed') AND r.status='held'
      AND r.hold_expires_at<=clock_timestamp() AND NOT ${protectedPaymentOccupancy} AND ($2::uuid IS NULL OR r.court_id=$2)
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
  const rows: unknown = await manager.query(`SELECT p.booking_id,b.reservation_id,c.location_id,r.coach_user_id
    FROM public.payment_attempts p JOIN public.checkout_records b LEFT JOIN public.booking_revisions v ON v.id=b.current_revision_id ON b.id=p.booking_id
    JOIN public.court_reservations r ON r.id=b.reservation_id JOIN public.courts c ON c.id=r.court_id
    WHERE p.id=$1`, [attemptId]);
  return z.array(z.object({ booking_id: z.uuid(), reservation_id: z.uuid(), location_id: z.uuid(), coach_user_id: z.uuid().nullable() })).max(1).parse(rows)[0] ?? null;
}

// Refund-only transactions read immutable financial facts without acquiring
// earlier aggregate locks after a refund lock.
export async function findRefundCaptureEvidence(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,adjustment_id,method,provider,provider_payment_id,amount_minor,currency,status
    FROM public.payment_attempts WHERE id=$1`, [attemptId]);
  const payment = z.array(z.object({ id:z.uuid(),booking_id:z.uuid(),adjustment_id:z.uuid().nullable().optional(),method:z.string(),provider:paymentProviderSchema.nullable(),
    provider_payment_id:z.string().nullable(),amount_minor:z.number().int(),currency:z.string(),status:z.string() })).max(1).parse(rows)[0] ?? null;
  const events: unknown = await manager.query(`SELECT e.provider,e.event_id,e.attempt_id,e.capture_receipt_id,c.provider_capture_id,
    e.provider_payment_id,e.outcome,e.amount_minor,e.currency,e.settlement_result,e.reconciliation_required
    FROM public.payment_provider_events e LEFT JOIN public.payment_capture_receipts c ON c.id=e.capture_receipt_id
    WHERE e.attempt_id=$1 ORDER BY e.provider,e.event_id`, [attemptId]);
  const captures = await manager.getRepository(PaymentCaptureReceiptEntity).find({
    where: { paymentAttemptId: attemptId }, order: { id: "ASC" },
  });
  return { payment, events: z.array(providerReceiptSchema).parse(events), captures };
}

export async function countBookingPaymentAttempts(manager: EntityManager, bookingId: string): Promise<number> {
  const rows: unknown = await manager.query("SELECT count(*)::integer AS total FROM public.payment_attempts WHERE booking_id=$1", [bookingId]);
  return z.array(z.object({ total: z.number().int() })).length(1).parse(rows)[0].total;
}


export async function listRefundObligationsForAttempt(manager: EntityManager, paymentAttemptId: string) {
  return manager.getRepository(PaymentRefundEntity).find({ where: { paymentAttemptId }, select: { amountMinor: true, status: true } });
}

export async function findRefundOperation(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentRefundEntity).findOne({ where: { id },
    select: { id: true, bookingId: true, adjustmentId: true, reason: true, status: true } });
}

// Compensation that settlement of this attempt owes and has not finished.
export async function listOutstandingCompensationRefunds(manager: EntityManager, attemptId: string) {
  const rows: unknown = await manager.query(`SELECT id FROM public.payment_refunds WHERE payment_attempt_id=$1
    AND status IN ('pending','pending_retry') AND reason IN ('late_capture_compensation','failed_adjustment_compensation')
    ORDER BY created_at,id`, [attemptId]);
  return z.array(z.object({ id: z.uuid() })).parse(rows).map(row => row.id);
}

// A dismissed modification can never be resumed or polled again.
export async function revokeCheckoutCapability(manager: EntityManager, id: string) {
  await manager.query("UPDATE public.payment_attempts SET checkout_token_hash=NULL,updated_at=now() WHERE id=$1", [id]);
}
// No provider payment was ever registered, so nothing can succeed later.
export async function cancelUnregisteredAttempt(manager: EntityManager, id: string) {
  await manager.query(`UPDATE public.payment_attempts SET status='cancelled',completed_at=clock_timestamp(),updated_at=now()
    WHERE id=$1 AND status='pending' AND provider_payment_id IS NULL`, [id]);
}
export async function reissueCheckoutCapability(manager: EntityManager, id: string, hash: string) {
  const rows: unknown = await manager.query(`WITH changed AS (UPDATE public.payment_attempts
    SET checkout_token_hash=$2,updated_at=now() WHERE id=$1 AND method='online' RETURNING id)
    SELECT id FROM changed`,[id,hash]);
  if (z.array(z.object({id:z.uuid()})).max(1).parse(rows).length !== 1) throw new Error("Checkout capability unavailable");
}

// Preserve attempt -> refund ordering; the caller already holds the booking lock.
export async function loadBookingFinancialFacts(manager: EntityManager, bookingId: string, lock = false, attemptId?: string) {
  const paymentQuery = manager.getRepository(PaymentAttemptEntity).createQueryBuilder("p")
    .where("p.bookingId=:bookingId", { bookingId }).orderBy("p.id");
  const refundQuery = manager.getRepository(PaymentRefundEntity).createQueryBuilder("r")
    .where("r.bookingId=:bookingId", { bookingId }).orderBy("r.id");
  if (attemptId) paymentQuery.andWhere("p.id=:attemptId", { attemptId });
  if (lock) { paymentQuery.setLock("pessimistic_write"); refundQuery.setLock("pessimistic_write"); }
  const payments = await paymentQuery.getMany();
  const refunds = await refundQuery.getMany();
  return { payments, refunds };
}

type RefundInsertFields = Pick<PaymentRefundEntity,
  "id" | "bookingId" | "paymentAttemptId" | "operationKey" | "adjustmentId" | "provider"
  | "providerPaymentId" | "amountMinor" | "capturedAmountMinor" | "currency" | "status" | "requestedByUserId" | "reason" | "contextRevisionId"
>;
export async function insertRefundAllocations(manager: EntityManager, rows: RefundInsertFields[]) {
  if (rows.length) await manager.getRepository(PaymentRefundEntity).insert(rows);
}

export async function insertAdjustmentAttempt(manager: EntityManager, input: Pick<PaymentAttemptEntity,
  "id" | "bookingId" | "adjustmentId" | "method" | "provider" | "amountMinor" | "currency" | "status" | "expiresAt"
>) {
  await manager.getRepository(PaymentAttemptEntity).insert(input);
}

// Batches are scoped to the already paginated bookings and immutable references.
// Classification and financial calculation belong to the application read model.
// Reads run in sequence: a transaction-bound manager has one connection, which
// must not receive concurrent queries.
export async function loadAdminTransactionContext(manager: EntityManager, input: {
  bookingIds: string[]; revisionIds: string[]; adjustmentIds: string[];
}) {
  const revisions = input.revisionIds.length ? await manager.getRepository(BookingRevisionEntity).findBy({ id: In(input.revisionIds) }) : [];
  const adjustments = input.adjustmentIds.length
    ? await manager.getRepository(BookingAdjustmentEntity).findBy({ id: In(input.adjustmentIds) }) : [];
  const payments = input.bookingIds.length ? await manager.getRepository(PaymentAttemptEntity).findBy({ bookingId: In(input.bookingIds) }) : [];
  const refunds = input.bookingIds.length ? await manager.getRepository(PaymentRefundEntity).findBy({ bookingId: In(input.bookingIds) }) : [];
  const captures = input.bookingIds.length ? await manager.getRepository(PaymentCaptureReceiptEntity).createQueryBuilder("capture")
    .innerJoin(PaymentAttemptEntity, "attempt", "attempt.id=capture.paymentAttemptId")
    .where("attempt.bookingId IN (:...bookingIds)", { bookingIds: input.bookingIds })
    .orderBy("capture.firstObservedAt").addOrderBy("capture.id").getMany() : [];
  const executions = refunds.length ? await manager.getRepository(RefundExecutionEntity).createQueryBuilder("execution")
    .where("execution.refundId IN (:...refundIds)", { refundIds: refunds.map(refund => refund.id) })
    .orderBy("execution.refundId").addOrderBy("execution.executionNumber").getMany() : [];
  const references = new Map<string, string | null>();
  for (const execution of executions) references.set(execution.refundId, execution.providerRefundId);
  return { revisions, adjustments, payments, captures, executions,
    refunds: refunds.map(refund => ({ ...refund, providerRefundId: references.get(refund.id) ?? null })) };
}
