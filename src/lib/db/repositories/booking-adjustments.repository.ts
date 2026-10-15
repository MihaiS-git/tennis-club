import "server-only";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { BookingAdjustmentEntity, type AdjustmentTarget } from "../entities/booking-adjustment.entity";
import { PaymentAttemptEntity } from "../entities/payment-attempt.entity";
import { PaymentRefundEntity } from "../entities/payment-refund.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { BookingEntity } from "../entities/booking.entity";
import { CourtEntity } from "../entities/court.entity";

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
  bookingId: string; baseRevisionId: string; actorId: string; scope: "owner" | "admin"; requestKey: string; target: AdjustmentTarget;
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
// Protect the target with the existing GiST exclusion, without overlapping the
// original confirmed occupancy. Fragments may be one half-hour long.
export async function insertAdjustmentHolds(manager: EntityManager, input: {
  adjustmentId: string; expiresAt: Date; fragments: readonly { courtId: string; date: string; startMinute: number; endMinute: number }[];
}) {
  for (const fragment of input.fragments) {
    await manager.getRepository(CourtReservationEntity).insert({ id: randomUUID(), courtId: fragment.courtId,
      adjustmentId: input.adjustmentId, bookingDate: fragment.date, startsAtMinute: fragment.startMinute, endsAtMinute: fragment.endMinute,
      status: "held", holdExpiresAt: input.expiresAt });
  }
}
export async function releaseAdjustmentHolds(manager: EntityManager, adjustmentId: string) {
  await manager.getRepository(CourtReservationEntity).update({ adjustmentId, status: "held" },
    { status: "released", holdExpiresAt: null, updatedAt: new Date() });
}
export async function listExpiredAdjustmentCandidates(manager: EntityManager, locationId: string) {
  const rows: unknown = await manager.getRepository(BookingAdjustmentEntity).createQueryBuilder("adjustment")
    .select("adjustment.id", "id").addSelect("adjustment.bookingId", "booking_id")
    .innerJoin(BookingEntity, "booking", "booking.id=adjustment.bookingId")
    .innerJoin(CourtReservationEntity, "reservation", "reservation.id=booking.reservationId")
    .innerJoin(CourtEntity, "court", "court.id=reservation.courtId")
    .where("court.locationId=:locationId", { locationId })
    .andWhere("adjustment.status IN (:...statuses)", { statuses: ["pending", "cancelled"] })
    .andWhere("adjustment.expiresAt <= clock_timestamp()")
    .andWhere(qb => "EXISTS " + qb.subQuery().select("1").from(PaymentAttemptEntity, "attempt")
      .where("attempt.adjustmentId=adjustment.id").andWhere("attempt.status=:attemptStatus").getQuery(),
      { attemptStatus: "pending" })
    .orderBy("adjustment.bookingId").getRawMany();
  return z.array(z.object({ id: z.uuid(), booking_id: z.uuid() })).parse(rows);
}
export async function listAdjustmentRefunds(manager: EntityManager, id: string) {
  return manager.getRepository(PaymentRefundEntity).find({ where: { adjustmentId: id }, order: { createdAt: "ASC", id: "ASC" } });
}
