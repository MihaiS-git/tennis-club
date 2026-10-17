import "server-only";
import type { EntityManager } from "typeorm";
import { BookingEntity } from "../entities/booking.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CourtEntity } from "../entities/court.entity";
import { findRevision, insertRevision } from "./booking-revisions.repository";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";

// Read the contractual snapshot, including historical/cancelled bookings and
// inactive resources. The caller must authorize an active Admin first.
export async function findAdminBookingDetails(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(`SELECT b.id,b.status,v.booking_date::text AS booking_date,
    v.starts_at_minute,v.ends_at_minute,
    v.location_name,v.timezone AS location_timezone,v.court_name,
    v.customer_name,v.customer_email,v.customer_phone,v.cancellation_notice_minutes,
    v.total_amount_minor,v.currency,v.payment_method,b.account_user_id
    FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE b.id=$1`, [id]);
  return z.array(z.object({
    id: z.uuid(), status: z.enum(["confirmed", "cancelled", "pending_payment", "failed", "expired"]),
    booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    location_name: z.string(), location_timezone: z.string(), court_name: z.string(),
    customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(),
    cancellation_notice_minutes: z.number().int(), total_amount_minor: z.number().int(), currency: z.enum(locationCurrencies),
    payment_method: z.enum(["online", "pay_at_club"]), account_user_id: z.uuid().nullable(),
  })).max(1).parse(rows)[0] ?? null;
}

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
// Owner-scoped read: another account's booking is indistinguishable from a missing one.
export async function findOwnedBookingRevision(manager: EntityManager, id: string, accountUserId: string) {
  const booking = await manager.getRepository(BookingEntity).findOneBy({ id, accountUserId });
  return booking ? { status: booking.status, revision: await findRevision(manager, booking.currentRevisionId) } : null;
}
