import "server-only";
import type { EntityManager } from "typeorm";

export type BookingFinancialExceptionKind = "cancellation_rejected" | "modification_rejected"
  | "refunded_modification_unapplied" | "surcharge_unapplied" | "late_capture"
  | "refund_failed" | "refund_unresolved" | "refund_reversed";

// Financial facts only: immutable references retain contact, schedule and amounts.
export async function recordBookingFinancialException(manager: EntityManager, input: {
  key: string; bookingId: string; revisionId: string; kind: BookingFinancialExceptionKind;
  adjustmentId?: string | null; paymentAttemptId?: string | null; refundId?: string | null;
}) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Financial evidence requires a transaction");
  const result: unknown[] = await manager.query(`INSERT INTO public.booking_financial_exceptions
      (event_key,booking_id,revision_id,kind,adjustment_id,payment_attempt_id,refund_id)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE
      ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM public.booking_adjustments WHERE id=$5 AND booking_id=$2)) AND
      ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM public.payment_attempts WHERE id=$6 AND booking_id=$2)) AND
      ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM public.payment_refunds WHERE id=$7 AND booking_id=$2))
    ON CONFLICT(event_key) DO NOTHING RETURNING event_key`,
  [input.key,input.bookingId,input.revisionId,input.kind,input.adjustmentId ?? null,input.paymentAttemptId ?? null,input.refundId ?? null]);
  if (!result.length) {
    const existing: unknown[] = await manager.query(`SELECT event_key FROM public.booking_financial_exceptions
      WHERE event_key=$1 AND booking_id=$2 AND (kind=$3 OR
        kind IN ('refund_failed','refund_unresolved') AND $3 IN ('refund_failed','refund_unresolved'))
        AND adjustment_id IS NOT DISTINCT FROM $4::uuid
        AND payment_attempt_id IS NOT DISTINCT FROM $5::uuid AND refund_id IS NOT DISTINCT FROM $6::uuid`,
    [input.key,input.bookingId,input.kind,input.adjustmentId ?? null,input.paymentAttemptId ?? null,input.refundId ?? null]);
    // A later observation can see a newer revision; the first occurrence owns context.
    if (!existing.length) throw new Error("Financial exception identity changed");
  }
}
