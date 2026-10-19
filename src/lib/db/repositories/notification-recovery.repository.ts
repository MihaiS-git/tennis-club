import "server-only";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import type { BookingFinancialExceptionKind } from "./booking-financial-exceptions.repository";

const candidateSchema = z.object({ key: z.string(), source: z.enum(["revision", "exception"]),
  revision_id: z.uuid(), occurred_at: z.string() });
export type NotificationRecoveryCandidate = z.infer<typeof candidateSchema>;

// Only explicitly opted-in revisions and newly committed exception facts.
// A historical missing delivery (including physical Admin deletion) is never inferred.
export async function listNotificationRecoveryCandidates(manager: EntityManager, limit: number) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Recovery selection requires a transaction");
  await manager.query("SELECT singleton FROM public.notification_recovery_cursor WHERE singleton FOR UPDATE");
  const rows: unknown = await manager.query(`WITH events AS (
    SELECT 'revision:'||v.id::text AS key,'revision' AS source,v.id AS revision_id,v.recorded_at AS occurred_at,v.booking_id
    FROM public.booking_revisions v LEFT JOIN public.booking_revisions previous ON previous.id=v.previous_revision_id
    WHERE v.recovery_version=1 AND (v.kind='confirmed' OR v.kind='created' AND v.booking_state='confirmed'
      OR v.kind='cancelled' AND v.cancellation_cause<>'checkout_abandoned'
      OR v.kind='rescheduled' AND (v.court_id,v.booking_date,v.starts_at_minute,v.ends_at_minute)
        IS DISTINCT FROM (previous.court_id,previous.booking_date,previous.starts_at_minute,previous.ends_at_minute)
      OR v.kind='rescheduled' AND v.adjustment_id IS NOT NULL AND v.total_amount_minor<previous.total_amount_minor)
    UNION ALL SELECT event_key,'exception',revision_id,occurred_at,booking_id FROM public.booking_financial_exceptions)
    SELECT e.key,e.source,e.revision_id,e.occurred_at::text FROM events e
    JOIN public.bookings b ON b.id=e.booking_id
    LEFT JOIN public.booking_notification_deliveries d ON d.event_key=e.key
    LEFT JOIN public.customer_notifications n ON n.event_key=e.key
    WHERE d.id IS NULL OR b.account_user_id IS NOT NULL AND n.id IS NULL
    ORDER BY COALESCE((e.occurred_at,e.key) <= (SELECT occurred_at,event_key
      FROM public.notification_recovery_cursor WHERE singleton),false),e.occurred_at,e.key LIMIT $1`, [limit]);
  const candidates = z.array(candidateSchema).parse(rows);
  const last = candidates.at(-1);
  // Commit traversal before projection attempts, including failures and crashes.
  // Wrap on the next pass; failed events never monopolize the first batch.
  if (last) await manager.query(`UPDATE public.notification_recovery_cursor
    SET occurred_at=$1::timestamptz,event_key=$2 WHERE singleton`, [last.occurred_at,last.key]);
  return candidates;
}

export async function findRecoveryException(manager: EntityManager, key: string) {
  const rows: unknown = await manager.query(`SELECT kind,refund_id,payment_attempt_id FROM public.booking_financial_exceptions WHERE event_key=$1`, [key]);
  // The database constrains the finite domain outcome vocabulary.
  return z.array(z.object({ kind: z.enum(["cancellation_rejected","modification_rejected","refunded_modification_unapplied",
    "surcharge_unapplied","late_capture","refund_failed","refund_unresolved","refund_reversed"]),
    refund_id: z.uuid().nullable(), payment_attempt_id: z.uuid().nullable() })).parse(rows)[0];
}
export type RecoveryExceptionKind = BookingFinancialExceptionKind;

export async function lockNotificationProjection(manager: EntityManager, key: string) {
  // Serialize projection/repair of a single source event without financial locks.
  await manager.query("SELECT pg_advisory_xact_lock(1791462258,hashtext($1))", [key]);
  const rows: unknown = await manager.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  return z.array(z.object({ id: z.uuid() })).parse(rows)[0] ?? null;
}

export async function repairNotificationInbox(manager: EntityManager, key: string, eventKind: string) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Inbox repair requires a transaction");
  // Serialize with acknowledgment before taking a new snapshot for the insert.
  await manager.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1 FOR UPDATE", [key]);
  // Read the already-snapshotted message, even if the email is dismissed. Do not
  // re-render history or reset existing read/deletion/acknowledgment timestamps.
  await manager.query(`INSERT INTO public.customer_notifications
    (id,event_key,account_user_id,booking_id,event_kind,subject,text,created_at,read_at,requires_acknowledgement,acknowledged_at)
    SELECT d.id,d.event_key,b.account_user_id,b.id,$2,d.message->>'subject',d.message->>'text',d.created_at,
      d.acknowledged_at,d.requires_acknowledgement,d.acknowledged_at
    FROM public.booking_notification_deliveries d JOIN public.bookings b ON b.id=d.booking_id
    WHERE d.event_key=$1 AND b.account_user_id IS NOT NULL ON CONFLICT(event_key) DO NOTHING`, [key,eventKind]);
}
