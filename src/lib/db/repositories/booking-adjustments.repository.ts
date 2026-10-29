import "server-only";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { checkoutCaptureGraceSeconds } from "@/lib/payments/domain";
import { BookingAdjustmentEntity, type AdjustmentKind, type AdjustmentTarget } from "../entities/booking-adjustment.entity";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";
import { PaymentRefundEntity } from "../entities/payment-refund.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CheckoutRecordEntity } from "../entities/checkout-record.entity";
import { CourtEntity } from "../entities/court.entity";

export async function findAdjustment(manager: EntityManager, id: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOneBy({ id });
}
export async function findPendingAdjustment(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOne({ where: { bookingId, status: "pending" } });
}
// Accepted capture protects a proposal even when it needs no extra occupancy.
// Processing payments retain their existing bounded occupancy lease.
const liveHold = `EXISTS(SELECT 1 FROM public.court_reservations r WHERE r.adjustment_id=a.id AND r.status='held'
  AND r.hold_expires_at>a.expires_at AND r.hold_expires_at>clock_timestamp())`;
const liveCapture = `a.capture_accepted_at IS NOT NULL`;
const livePayment = `p.status='pending' AND ((${liveCapture}) OR ${liveHold})`;
export async function listBookingsWithLivePayment(manager: EntityManager, bookingIds: readonly string[]) {
  if (!bookingIds.length) return new Set<string>();
  const rows: unknown = await manager.query(`SELECT DISTINCT a.booking_id FROM public.booking_adjustments a
    JOIN public.payment_attempts p ON p.adjustment_id=a.id WHERE a.booking_id=ANY($1::uuid[]) AND ${livePayment}`, [bookingIds]);
  return new Set(z.array(z.object({ booking_id: z.uuid() })).parse(rows).map(r => r.booking_id));
}
// Caller holds the location and booking locks, which every lease writer takes.
export async function hasLivePayment(manager: EntityManager, adjustmentId: string) {
  const rows: unknown = await manager.query(`SELECT 1 AS live FROM public.booking_adjustments a
    JOIN public.payment_attempts p ON p.adjustment_id=a.id WHERE a.id=$1 AND ${livePayment}`, [adjustmentId]);
  return z.array(z.object({ live: z.number() })).parse(rows).length > 0;
}
// Occupancy lease of a live payment, bounded by the target slot start. The
// lateness cutoff (booking_adjustments.expires_at) never moves.
export async function extendAdjustmentLease(manager: EntityManager, adjustmentId: string, until: string) {
  await manager.query(`UPDATE public.court_reservations SET hold_expires_at=greatest(hold_expires_at,$2::timestamptz),updated_at=now()
    WHERE adjustment_id=$1 AND status='held' AND $2::timestamptz>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.booking_adjustments a WHERE a.id=$1 AND a.capture_accepted_at IS NOT NULL)`, [adjustmentId, until]);
}
// The payment is no longer in flight; the lease returns to the lateness cutoff.
export async function resetAdjustmentLease(manager: EntityManager, adjustmentId: string) {
  await manager.query(`UPDATE public.court_reservations r SET hold_expires_at=a.expires_at,updated_at=now()
    FROM public.booking_adjustments a WHERE a.id=$1 AND r.adjustment_id=a.id AND r.status='held' AND r.hold_expires_at>a.expires_at AND a.capture_accepted_at IS NULL`, [adjustmentId]);
}
// Occupancy validity only; capture acceptance lives on the proposal itself.
export async function readAdjustmentHolds(manager: EntityManager, adjustmentId: string) {
  const rows: unknown = await manager.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='held' AND hold_expires_at>clock_timestamp())::int AS valid
    FROM public.court_reservations WHERE adjustment_id=$1`, [adjustmentId]);
  return z.array(z.object({ total: z.number().int(), valid: z.number().int() })).length(1).parse(rows)[0];
}
// Caller owns location -> booking -> reservation -> attempt locks. Acceptance
// and any occupancy extension commit together, including the zero-fragment case.
// The final conditional write rechecks wall time and every fragment.
export async function acceptAdjustmentCapture(manager: EntityManager, adjustmentId: string) {
  const rows: unknown = await manager.query(`WITH accepted AS (
    UPDATE public.booking_adjustments a SET capture_accepted_at=clock_timestamp(),updated_at=now()
    WHERE a.id=$1 AND a.status='pending' AND a.capture_accepted_at IS NULL AND a.expires_at>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.court_reservations r WHERE r.adjustment_id=a.id
        AND (r.status<>'held' OR r.hold_expires_at<=clock_timestamp()))
    RETURNING a.id,a.expires_at), extended AS (
    UPDATE public.court_reservations r SET hold_expires_at=a.expires_at+make_interval(secs => $2::integer),updated_at=now()
    FROM accepted a WHERE r.adjustment_id=a.id AND r.status='held' RETURNING r.id)
    SELECT id FROM accepted`, [adjustmentId, checkoutCaptureGraceSeconds]);
  return z.array(z.object({ id: z.uuid() })).max(1).parse(rows).length === 1;
}
export async function findAdjustmentRequest(manager: EntityManager, bookingId: string, requestKey: string) {
  return manager.getRepository(BookingAdjustmentEntity).findOneBy({ bookingId, requestKey });
}
export async function insertAdjustment(manager: EntityManager, input: {
  bookingId: string; baseRevisionId: string; actorId: string; scope: "owner" | "admin"; requestKey: string; target: AdjustmentTarget;
  originalTotal: number; newTotal: number; currency: string; expiresAt: Date; kind?: AdjustmentKind; createdAt?: Date;
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
// Protect the target with the existing GiST exclusions, without overlapping the
// original confirmed occupancy. Fragments may be one half-hour long; a coaching
// fragment also names the coach, so court_reservation_coach_no_overlap holds it.
export async function insertAdjustmentHolds(manager: EntityManager, input: {
  adjustmentId: string; expiresAt: Date;
  fragments: readonly { courtId: string; date: string; startMinute: number; endMinute: number; coachUserId?: string | null }[];
}) {
  for (const fragment of input.fragments) {
    await manager.getRepository(CourtReservationEntity).insert({ id: randomUUID(), courtId: fragment.courtId,
      adjustmentId: input.adjustmentId, bookingDate: fragment.date, startsAtMinute: fragment.startMinute, endsAtMinute: fragment.endMinute,
      status: "held", holdExpiresAt: input.expiresAt, coachUserId: fragment.coachUserId ?? null });
  }
}
export async function releaseAdjustmentHolds(manager: EntityManager, adjustmentId: string) {
  await manager.getRepository(CourtReservationEntity).update({ adjustmentId, status: "held" },
    { status: "released", holdExpiresAt: null, updatedAt: new Date() });
}
export async function listExpiredAdjustmentCandidates(manager: EntityManager, locationId: string) {
  const rows: unknown = await manager.getRepository(BookingAdjustmentEntity).createQueryBuilder("adjustment")
    .select("adjustment.id", "id").addSelect("adjustment.bookingId", "booking_id")
    .innerJoin(CheckoutRecordEntity, "booking", "booking.id=adjustment.bookingId")
    .innerJoin(CourtReservationEntity, "reservation", "reservation.id=booking.reservationId")
    .innerJoin(CourtEntity, "court", "court.id=reservation.courtId")
    .where("court.locationId=:locationId", { locationId })
    .andWhere("adjustment.status IN (:...statuses)", { statuses: ["pending", "cancelled"] })
    .andWhere("adjustment.expiresAt <= clock_timestamp()")
    .andWhere("adjustment.captureAcceptedAt IS NULL")
    .andWhere(qb => "EXISTS " + qb.subQuery().select("1").from(PaymentAttemptEntity, "attempt")
      .where("attempt.adjustmentId=adjustment.id").andWhere("attempt.status=:attemptStatus").getQuery(),
      { attemptStatus: "pending" })
    // A live payment keeps its target blocked until it resolves or its lease ends.
    .andWhere(qb => "NOT EXISTS " + qb.subQuery().select("1").from(CourtReservationEntity, "lease")
      .where("lease.adjustmentId=adjustment.id").andWhere("lease.status='held'")
      .andWhere("lease.holdExpiresAt > clock_timestamp()").getQuery())
    .orderBy("adjustment.bookingId").getRawMany();
  return z.array(z.object({ id: z.uuid(), booking_id: z.uuid() })).parse(rows);
}
export async function listBookingsWithPendingChange(manager: EntityManager, bookingIds: readonly string[]) {
  if (!bookingIds.length) return new Map<string, AdjustmentKind>();
  const rows = await manager.getRepository(BookingAdjustmentEntity).createQueryBuilder("adjustment")
    .select("adjustment.bookingId", "booking_id").addSelect("adjustment.kind", "kind")
    .where("adjustment.bookingId IN (:...bookingIds)", { bookingIds }).andWhere("adjustment.status = 'pending'")
    .andWhere(qb => "NOT EXISTS " + qb.subQuery().select("1").from(PaymentAttemptEntity, "attempt")
      .where("attempt.adjustmentId=adjustment.id").getQuery()).getRawMany();
  return new Map(z.array(z.object({ booking_id: z.uuid(), kind: z.enum(["reschedule", "cancellation"]) })).parse(rows)
    .map(row => [row.booking_id, row.kind]));
}
export async function listAdjustmentRefunds(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentRefundEntity).find({ where: { adjustmentId: id }, order: { createdAt: "ASC", id: "ASC" } });
}
// Every recorded change request for read-only history, including unapplied ones.
export async function listBookingAdjustments(manager: EntityManager, bookingId: string) {
  return manager.getRepository(BookingAdjustmentEntity).find({ where: { bookingId }, order: { createdAt: "ASC", id: "ASC" } });
}
