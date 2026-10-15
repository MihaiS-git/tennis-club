import "server-only";
import type { EntityManager } from "typeorm";
import { BookingEntity } from "../entities/booking.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CourtEntity } from "../entities/court.entity";
import { findRevision, insertRevision } from "./booking-revisions.repository";
import type { RevisionSnapshot } from "@/lib/bookings/revision";

export async function insertCheckoutBooking(manager: EntityManager, input: {
  id: string; reservationId: string; accountUserId: string | null; status: BookingEntity["status"]; revision: RevisionSnapshot;
}) {
  await manager.getRepository(BookingEntity).insert({ id: input.id, reservationId: input.reservationId,
    accountUserId: input.accountUserId, status: input.status, currentRevisionId: input.revision.id });
  await insertRevision(manager, input.revision);
}
export async function findBookingCancellationNotice(manager: EntityManager, id: string) {
  const booking = await manager.getRepository(BookingEntity).findOneBy({ id });
  return booking ? findRevision(manager, booking.currentRevisionId) : null;
}
export function findCheckoutBookingStatus(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).findOne({ where: { id }, select: { status: true } });
}
export function lockCheckoutBooking(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).createQueryBuilder("booking")
    .where("booking.id = :id", { id }).setLock("pessimistic_write").getOne();
}
export async function discoverBookingLocation(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).createQueryBuilder("b")
    .innerJoin(CourtReservationEntity, "r", "r.id=b.reservationId")
    .innerJoin(CourtEntity, "c", "c.id=r.courtId").select("c.locationId", "location_id")
    .where("b.id=:id", { id }).getRawOne<{ location_id: string }>();
}
export async function findBookingForUpdate(manager: EntityManager, id: string, revisionId?: string) {
  const b = await lockCheckoutBooking(manager, id);
  if (!b) return null;
  const v = await findRevision(manager, b.currentRevisionId);
  return { id: b.id, reservation_id: b.reservationId, account_user_id: b.accountUserId, status: b.status,
    current_revision_id: v.id, revision: v, customer_name: v.customerName, customer_email: v.customerEmail,
    customer_phone: v.customerPhone, total_amount_minor: v.totalAmountMinor, currency: v.currency,
    cancellation_notice_minutes: v.cancellationNoticeMinutes, payment_method: v.paymentMethod,
    updated_at: b.updatedAt.toISOString(), token_matches: revisionId ? revisionId === v.id : null };
}
export async function updateSettlementBookingStatus(manager: EntityManager, id: string, status: BookingEntity["status"]) {
  await manager.getRepository(BookingEntity).update(id, { status, updatedAt: new Date() });
}
