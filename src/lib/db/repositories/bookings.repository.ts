import "server-only";
import type { EntityManager } from "typeorm";
import { BookingEntity } from "../entities/booking.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CourtEntity } from "../entities/court.entity";
import { findRevision, insertRevision } from "./booking-revisions.repository";
import { pricingEvidenceSchema, type RevisionSnapshot } from "@/lib/bookings/revision";
import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";

const createdAt = "replace((b.created_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS created_at";

// Read the contractual snapshot, including historical/cancelled bookings and
// inactive resources. The caller must authorize an active Admin first.
export async function findAdminBookingDetails(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(`SELECT b.id,b.status,v.booking_date::text AS booking_date,
    v.starts_at_minute,v.ends_at_minute,
    v.location_name,v.timezone AS location_timezone,v.court_name,
    v.customer_name,v.customer_email,v.customer_phone,v.cancellation_notice_minutes,
    v.total_amount_minor,v.currency,v.payment_method,b.account_user_id,
    (v.coach_user_id IS NOT NULL) AS includes_coaching,v.coach_name,v.coaching_program_name,
    v.pricing_evidence->'coaching' AS coaching,${createdAt}
    FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE b.id=$1`, [id]);
  return z.array(z.object({
    id: z.uuid(), status: z.enum(["confirmed", "cancelled", "pending_payment", "failed", "expired"]),
    booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    location_name: z.string(), location_timezone: z.string(), court_name: z.string(),
    customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(),
    cancellation_notice_minutes: z.number().int(), total_amount_minor: z.number().int(), currency: z.enum(locationCurrencies),
    payment_method: z.enum(["online", "pay_at_club"]), account_user_id: z.uuid().nullable(),
    created_at: z.iso.datetime({ offset: true }),
    includes_coaching: z.boolean(), coach_name: z.string().nullable(), coaching_program_name: z.string().nullable(),
    coaching: pricingEvidenceSchema.shape.coaching.unwrap().nullable(),
  })).max(1).parse(rows)[0] ?? null;
}

export type AdminBookingListFilters = {
  coachId: string | null; type: "all" | "court" | "coaching"; search: string; status: BookingEntity["status"] | null; locationId: string | null; courtId: string | null;
  from: string | null; to: string | null; sort: "created" | "scheduled"; direction: "asc" | "desc";
};
// Customer bookings only (direct staff reservations have no booking row), filtered on the
// current contractual snapshot so historical names, prices and archived resources remain visible.
function adminBookingsWhere(filters: AdminBookingListFilters) {
  return {
    sql: `FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE ($1::text IS NULL OR b.status::text=$1) AND ($2::uuid IS NULL OR v.location_id=$2)
      AND ($3::uuid IS NULL OR v.court_id=$3) AND ($4::date IS NULL OR v.booking_date>=$4) AND ($5::date IS NULL OR v.booking_date<=$5)
      AND ($6::text='' OR strpos(b.id::text,lower($6))>0 OR strpos(lower(v.customer_name),lower($6))>0
        OR strpos(lower(v.customer_email),lower($6))>0)
      AND ($7::text='all' OR ($7='court' AND v.coach_user_id IS NULL)
        OR ($7='coaching' AND v.coach_user_id IS NOT NULL))
      AND ($8::uuid IS NULL OR v.coach_user_id=$8)`,
    parameters: [filters.status, filters.locationId, filters.courtId, filters.from, filters.to, filters.search, filters.type, filters.coachId],
  };
}
export async function countAdminBookings(manager: EntityManager, filters: AdminBookingListFilters) {
  const where = adminBookingsWhere(filters);
  const rows: unknown = await manager.query(`SELECT count(*)::int AS total ${where.sql}`, where.parameters);
  return z.array(z.object({ total: z.number().int().nonnegative() })).length(1).parse(rows)[0].total;
}
export async function findAdminBookingsPage(manager: EntityManager, filters: AdminBookingListFilters, offset: number, limit: number) {
  const where = adminBookingsWhere(filters);
  // Direction comes from a closed enum; ties stay deterministic across pages.
  const dir = filters.direction === "asc" ? "ASC" : "DESC";
  const order = filters.sort === "scheduled"
    ? `v.booking_date ${dir},v.starts_at_minute ${dir},b.created_at DESC,b.id`
    : `b.created_at ${dir},b.id ${dir}`;
  const rows: unknown = await manager.query(`SELECT b.id,b.status,${createdAt},b.account_user_id,
    v.booking_date::text AS booking_date,v.starts_at_minute,v.ends_at_minute,v.location_id,v.location_name,
    v.timezone AS location_timezone,v.court_id,v.court_name,v.customer_name,v.customer_email,v.total_amount_minor,v.currency,
    (v.coach_user_id IS NOT NULL) AS includes_coaching,v.coach_name,v.coaching_program_name
    ${where.sql} ORDER BY ${order} OFFSET $9 LIMIT $10`, [...where.parameters, offset, limit]);
  return z.array(z.object({
    id: z.uuid(), status: z.enum(["confirmed", "cancelled", "pending_payment", "failed", "expired"]),
    created_at: z.iso.datetime({ offset: true }), account_user_id: z.uuid().nullable(),
    includes_coaching: z.boolean(), coach_name: z.string().nullable(), coaching_program_name: z.string().nullable(),
    booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    location_id: z.uuid(), location_name: z.string(), location_timezone: z.string(), court_id: z.uuid(), court_name: z.string(),
    customer_name: z.string(), customer_email: z.string(), total_amount_minor: z.number().int(), currency: z.enum(locationCurrencies),
  })).parse(rows);
}

// One option per stored coach identity, across all booking lifecycles. Pick the
// most recently recorded contractual name deterministically when it changed.
// No live coach/account visibility restriction may hide historical bookings.
export async function listAdminBookingCoaches(manager: EntityManager) {
  const rows: unknown = await manager.query(`SELECT id,name FROM (
    SELECT DISTINCT ON (v.coach_user_id) v.coach_user_id AS id,v.coach_name AS name
    FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE v.coach_user_id IS NOT NULL
    ORDER BY v.coach_user_id,v.recorded_at DESC,v.id DESC
  ) coaches ORDER BY lower(name),name,id`);
  return z.array(z.object({ id: z.uuid(), name: z.string() })).parse(rows);
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
