import "server-only";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { BookingAdjustmentEntity, type AdjustmentTarget } from "../entities/booking-adjustment.entity";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";
import { PaymentRefundEntity } from "../entities/payment-refund.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";

export async function hasBookingAdjustments(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingAdjustmentEntity).existsBy({bookingId});
}
export async function findAdjustment(manager: EntityManager, id: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOneBy({ id });
}
export async function findPendingAdjustment(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOne({ where: { bookingId, status: "pending" } });
}
export async function findUnresolvedAdjustment(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingAdjustmentEntity).createQueryBuilder("a")
    .where("a.bookingId=:bookingId", { bookingId })
    .andWhere("(a.status='pending' OR EXISTS(SELECT 1 FROM public.payment_attempts p WHERE p.adjustment_id=a.id AND p.status IN ('pending','expired')))")
    .orderBy("a.createdAt","DESC").getOne();
}
export async function findAdjustmentRequest(manager: EntityManager, bookingId: string, requestKey: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOneBy({ bookingId, requestKey });
}
export async function insertAdjustment(manager: EntityManager, input: {
  bookingId: string; actorId: string; scope: "owner" | "admin"; requestKey: string; target: AdjustmentTarget;
  originalTotal: number; newTotal: number; currency: string; expiresAt: Date;
}) {
  const value = manager.getRepository(BookingAdjustmentEntity).create({ ...input, id: randomUUID(), status: "pending" });
  await manager.getRepository(BookingAdjustmentEntity).insert(value);
  return value;
}
export async function updateAdjustment(manager: EntityManager, id: string, status: BookingAdjustmentEntity["status"]) {
  await manager.getRepository(BookingAdjustmentEntity).update(id, { status, updatedAt: new Date() });
}
export async function adjustmentAttempt(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentAttemptEntity).findOneBy({ adjustmentId: id });
}
export async function insertAdjustmentAttempt(manager: EntityManager, value: BookingAdjustmentEntity) {
  const attempt = manager.getRepository(PaymentAttemptEntity).create({ id: randomUUID(), bookingId: value.bookingId,
    adjustmentId: value.id, method: "online", provider: "stripe", amountMinor: value.newTotal - value.originalTotal,
    currency: z.enum(locationCurrencies).parse(value.currency), status: "pending", expiresAt: value.expiresAt });
  await manager.getRepository(PaymentAttemptEntity).insert(attempt);
  return attempt;
}

// Protect the target with the existing GiST exclusion, without overlapping the
// original confirmed occupancy. Fragments may be one half-hour long.
export async function insertAdjustmentHolds(manager: EntityManager, adjustment: BookingAdjustmentEntity,
  original: { court_id: string; booking_date: string; starts_at_minute: number; ends_at_minute: number }) {
  const t = adjustment.target;
  const same = original.court_id === t.courtId && original.booking_date === t.date;
  const fragments = same ? [
    [t.startMinute, Math.min(t.endMinute, original.starts_at_minute)],
    [Math.max(t.startMinute, original.ends_at_minute), t.endMinute],
  ] : [[t.startMinute, t.endMinute]];
  for (const [start, end] of fragments) if (end > start) {
    await manager.getRepository(CourtReservationEntity).insert({ id: randomUUID(), courtId: t.courtId,
      adjustmentId: adjustment.id, bookingDate: t.date, startsAtMinute: start, endsAtMinute: end,
      status: "held", holdExpiresAt: adjustment.expiresAt });
  }
}
export async function releaseAdjustmentHolds(manager: EntityManager, adjustmentId: string) {
  await manager.getRepository(CourtReservationEntity).update({ adjustmentId, status: "held" },
    { status: "released", holdExpiresAt: null, updatedAt: new Date() });
}
export async function expireAdjustmentsAtLocation(manager: EntityManager, locationId: string) {
  const rows: unknown = await manager.query(`SELECT a.id,a.booking_id FROM public.booking_adjustments a
    JOIN public.bookings b ON b.id=a.booking_id JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.courts c ON c.id=r.court_id
    WHERE c.location_id=$1 AND a.status IN ('pending','cancelled') AND a.expires_at<=clock_timestamp() AND EXISTS(SELECT 1 FROM public.payment_attempts p WHERE p.adjustment_id=a.id AND p.status='pending')
    ORDER BY a.booking_id`, [locationId]);
  const candidates = z.array(z.object({ id: z.uuid(), booking_id: z.uuid() })).parse(rows);
  for (const row of candidates) {
    await manager.query("SELECT id FROM public.bookings WHERE id=$1 FOR UPDATE", [row.booking_id]);
    const current = await findAdjustment(manager, row.id);
    if (!current || !["pending","cancelled"].includes(current.status)) continue;
    if (current.status === "pending") await updateAdjustment(manager, row.id, "expired");
    await manager.query(`UPDATE public.payment_attempts SET status='expired',completed_at=clock_timestamp(),updated_at=now()
      WHERE adjustment_id=$1 AND status='pending'`, [row.id]);
    await releaseAdjustmentHolds(manager, row.id);
  }
  return candidates.length;
}
export async function listAdjustmentRefunds(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentRefundEntity).find({ where: { adjustmentId: id }, order: { createdAt: "ASC", id: "ASC" } });
}

export async function bookingFinancials(manager: EntityManager, bookingId: string, lock = false) {
  const paymentQuery = manager.getRepository(PaymentAttemptEntity).createQueryBuilder("p")
    .where("p.bookingId=:bookingId", { bookingId }).orderBy("p.id");
  const refundQuery = manager.getRepository(PaymentRefundEntity).createQueryBuilder("r")
    .where("r.bookingId=:bookingId", { bookingId }).orderBy("r.id");
  if (lock) { paymentQuery.setLock("pessimistic_write"); refundQuery.setLock("pessimistic_write"); }
  const payments = await paymentQuery.getMany(), refunds = await refundQuery.getMany();
  const captures = payments.filter(p => p.status === "succeeded" && p.method === "online" && p.provider === "stripe" && p.providerPaymentId);
  const captured = captures.reduce((sum, p) => sum + p.amountMinor, 0);
  const refunded = refunds.filter(r => r.status === "succeeded").reduce((sum, r) => sum + r.amountMinor, 0);
  const obligated = refunds.reduce((sum, r) => sum + r.amountMinor, 0);
  return { payments, refunds, captures, captured, refunded, obligated, netPaid: captured - refunded,
    refundable: captured - obligated };
}

// Caller owns location and booking locks. All durable obligations, including
// pending/failed ones, reserve funds so retries and cancellation cannot over-refund.
export async function allocateBookingRefund(manager: EntityManager, input: {
  bookingId: string; amount: number; operationKey: string; adjustmentId?: string; actorId: string | null; onlyAttemptId?: string;
}) {
  const facts = await bookingFinancials(manager, input.bookingId, true);
  const existing = facts.refunds.filter(r => r.operationKey === input.operationKey);
  if (existing.length) return existing.map(r => r.id);
  const balances = facts.captures.filter(p => !input.onlyAttemptId || p.id === input.onlyAttemptId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .map(p => ({ payment: p, remaining: p.amountMinor - facts.refunds.filter(r => r.paymentAttemptId === p.id).reduce((sum, r) => sum + r.amountMinor, 0) }));
  if (input.amount > balances.reduce((sum, b) => sum + b.remaining, 0)) throw new Error("Insufficient unrefunded captured funds");
  let left = input.amount;
  const ids: string[] = [];
  for (const { payment, remaining } of balances) {
    const amount = Math.min(left, remaining);
    if (amount <= 0) continue;
    const id = randomUUID();
    await manager.getRepository(PaymentRefundEntity).insert({ id, bookingId: input.bookingId, paymentAttemptId: payment.id,
      operationKey: input.operationKey, adjustmentId: input.adjustmentId ?? null, provider: "stripe",
      providerPaymentId: payment.providerPaymentId ?? undefined, amountMinor: amount, capturedAmountMinor: payment.amountMinor, currency: payment.currency,
      status: "pending", requestedByUserId: input.actorId });
    ids.push(id); left -= amount;
  }
  return ids;
}
