import "server-only";
import type { EntityManager } from "typeorm";
import { CheckoutRecordEntity } from "../entities/checkout-record.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CourtEntity } from "../entities/court.entity";
import { findRevision, insertRevision, confirmBookingRecord } from "./booking-revisions.repository";
import { pricingEvidenceSchema, type RevisionSnapshot } from "@/lib/bookings/revision";
import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { directReservationPredicate, staffNameSql } from "./reservations.repository";

const createdAt = "replace((b.created_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS created_at";

// Read the contractual snapshot, including historical/cancelled bookings and
// inactive resources. The caller must authorize an active Admin first, or a Coach
// and then restrict the result to their own lesson.
export async function findAdminBookingDetails(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(`SELECT b.id,b.status,v.booking_date::text AS booking_date,
    v.starts_at_minute,v.ends_at_minute,
    v.location_name,v.timezone AS location_timezone,v.court_name,
    v.customer_name,v.customer_email,v.customer_phone,v.cancellation_notice_minutes,
    v.total_amount_minor,v.currency,v.payment_method,b.account_user_id,
    (v.coach_user_id IS NOT NULL) AS includes_coaching,v.coach_name,v.coaching_program_name,
    v.pricing_evidence->'coaching' AS coaching,v.coach_user_id,${createdAt}
    FROM public.checkout_records b JOIN public.bookings confirmed ON confirmed.id=b.id JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
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
    coaching: pricingEvidenceSchema.shape.coaching.unwrap().nullable(), coach_user_id: z.uuid().nullable(),
  })).max(1).parse(rows)[0] ?? null;
}

export type AdminBookingListFilters = {
  coachId: string | null; type: "all" | "court" | "coaching" | "reservation"; search: string;
  status: CheckoutRecordEntity["status"] | "active" | null; locationId: string | null; courtId: string | null;
  from: string | null; to: string | null; sort: "created" | "scheduled"; direction: "asc" | "desc";
  // Set for a Coach: only their own confirmed or cancelled lessons and their own staff reservations.
  staffUserId?: string | null;
};
// Customer bookings, filtered on the current contractual snapshot so historical names,
// prices and archived resources remain visible. "active" is a staff reservation status only.
function adminBookingsWhere() {
  return `FROM public.checkout_records b JOIN public.bookings confirmed ON confirmed.id=b.id JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE ($1::text IS NULL OR b.status::text=$1) AND ($2::uuid IS NULL OR v.location_id=$2)
      AND ($3::uuid IS NULL OR v.court_id=$3) AND ($4::date IS NULL OR v.booking_date>=$4) AND ($5::date IS NULL OR v.booking_date<=$5)
      AND ($6::text='' OR strpos(b.id::text,lower($6))>0 OR strpos(lower(v.customer_name),lower($6))>0
        OR strpos(lower(v.customer_email),lower($6))>0)
      AND ($7::text='all' OR ($7='court' AND v.coach_user_id IS NULL)
        OR ($7='coaching' AND v.coach_user_id IS NOT NULL))
      AND ($8::uuid IS NULL OR v.coach_user_id=$8)
      AND ($9::uuid IS NULL OR (v.coach_user_id=$9 AND b.status IN ('confirmed','cancelled')))`;
}
// Direct staff reservations are separate free records (no booking row, price or payment);
// they have no snapshot, so they show their current, possibly archived, resources.
function adminDirectReservationsWhere() {
  return `FROM public.court_reservations r JOIN public.courts c ON c.id=r.court_id JOIN public.locations l ON l.id=c.location_id
    LEFT JOIN public.users u ON u.id=r.created_by_user_id LEFT JOIN public.player_profiles p ON p.user_id=u.id
    WHERE ${directReservationPredicate} AND $7::text IN ('all','reservation') AND $8::uuid IS NULL
      AND ($9::uuid IS NULL OR r.created_by_user_id=$9)
      AND ($1::text IS NULL OR r.status::text=$1) AND ($2::uuid IS NULL OR c.location_id=$2)
      AND ($3::uuid IS NULL OR r.court_id=$3) AND ($4::date IS NULL OR r.booking_date>=$4) AND ($5::date IS NULL OR r.booking_date<=$5)
      AND ($6::text='' OR strpos(r.id::text,lower($6))>0 OR strpos(lower(coalesce(r.reason,'')),lower($6))>0
        OR strpos(lower(${staffNameSql("u", "p")}),lower($6))>0 OR strpos(lower(u.email),lower($6))>0)`;
}
function adminListParameters(filters: AdminBookingListFilters) {
  return [filters.status, filters.locationId, filters.courtId, filters.from, filters.to, filters.search, filters.type, filters.coachId,
    filters.staffUserId ?? null];
}
export async function countAdminBookings(manager: EntityManager, filters: AdminBookingListFilters) {
  const rows: unknown = await manager.query(`SELECT ((SELECT count(*) ${adminBookingsWhere()})
    + (SELECT count(*) ${adminDirectReservationsWhere()}))::int AS total`, adminListParameters(filters));
  return z.array(z.object({ total: z.number().int().nonnegative() })).length(1).parse(rows)[0].total;
}
const listRowFields = { id: z.uuid(), created_at: z.iso.datetime({ offset: true }),
  booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  location_id: z.uuid(), location_name: z.string(), location_timezone: z.string(), court_id: z.uuid(), court_name: z.string() };
export async function findAdminBookingsPage(manager: EntityManager, filters: AdminBookingListFilters, offset: number, limit: number) {
  // Direction comes from a closed enum; ties stay deterministic across pages.
  const dir = filters.direction === "asc" ? "ASC" : "DESC";
  const order = filters.sort === "scheduled"
    ? `x.booking_date ${dir},x.starts_at_minute ${dir},x.created_sort DESC,x.id`
    : `x.created_sort ${dir},x.id ${dir}`;
  const rows: unknown = await manager.query(`SELECT x.* FROM (
    SELECT 'booking' AS kind,b.id,b.status::text AS status,b.created_at AS created_sort,${createdAt},b.account_user_id,
      v.booking_date::text AS booking_date,v.starts_at_minute,v.ends_at_minute,v.location_id,v.location_name,
      v.timezone AS location_timezone,v.court_id,v.court_name,v.customer_name,v.customer_email,v.total_amount_minor,v.currency::text AS currency,
      (v.coach_user_id IS NOT NULL) AS includes_coaching,v.coach_name,v.coaching_program_name,
      NULL::text AS reason,NULL::text AS creator_name,NULL::text AS creator_email
    ${adminBookingsWhere()}
    UNION ALL
    SELECT 'reservation',r.id,r.status::text,r.created_at,replace((r.created_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00',NULL::uuid,
      r.booking_date::text,r.starts_at_minute,r.ends_at_minute,l.id,l.name,l.timezone,c.id,c.name,NULL,NULL,NULL::int,NULL,false,NULL,NULL,
      r.reason,${staffNameSql("u", "p")},u.email
    ${adminDirectReservationsWhere()}
  ) x ORDER BY ${order} OFFSET $10 LIMIT $11`, [...adminListParameters(filters), offset, limit]);
  return z.array(z.discriminatedUnion("kind", [z.object({ ...listRowFields, kind: z.literal("booking"),
    status: z.enum(["confirmed", "cancelled", "pending_payment", "failed", "expired"]), account_user_id: z.uuid().nullable(),
    includes_coaching: z.boolean(), coach_name: z.string().nullable(), coaching_program_name: z.string().nullable(),
    customer_name: z.string(), customer_email: z.string(), total_amount_minor: z.number().int(), currency: z.enum(locationCurrencies),
  }), z.object({ ...listRowFields, kind: z.literal("reservation"), status: z.enum(["active", "cancelled"]),
    reason: z.string().nullable(), creator_name: z.string().nullable(), creator_email: z.string().nullable() })])).parse(rows);
}

// One option per stored coach identity, across all booking lifecycles. Pick the
// most recently recorded contractual name deterministically when it changed.
// No live coach/account visibility restriction may hide historical bookings.
export async function listAdminBookingCoaches(manager: EntityManager) {
  const rows: unknown = await manager.query(`SELECT id,name FROM (
    SELECT DISTINCT ON (v.coach_user_id) v.coach_user_id AS id,v.coach_name AS name
    FROM public.checkout_records b JOIN public.bookings confirmed ON confirmed.id=b.id JOIN public.booking_revisions v ON v.id=b.current_revision_id AND v.booking_id=b.id
    WHERE v.coach_user_id IS NOT NULL
    ORDER BY v.coach_user_id,v.recorded_at DESC,v.id DESC
  ) coaches ORDER BY lower(name),name,id`);
  return z.array(z.object({ id: z.uuid(), name: z.string() })).parse(rows);
}

export async function insertCheckoutBooking(manager: EntityManager, input: {
  id: string; reservationId: string; accountUserId: string | null; status: CheckoutRecordEntity["status"]; revision: RevisionSnapshot;
}) {
  await manager.getRepository(CheckoutRecordEntity).insert({ id: input.id, reservationId: input.reservationId,
    accountUserId: input.accountUserId, status: input.status, currentRevisionId: input.revision.id });
  await insertRevision(manager, input.revision);
  if (input.status === "confirmed") await confirmBookingRecord(manager, input.id, input.revision.id);
}
export async function findBookingCancellationNotice(manager: EntityManager, id: string) {
  const booking = await manager.getRepository(CheckoutRecordEntity).findOneBy({ id });
  return booking ? findRevision(manager, booking.currentRevisionId) : null;
}
export function findCheckoutBookingStatus(manager: EntityManager, id: string) {
  return manager.getRepository(CheckoutRecordEntity).findOne({ where: { id }, select: { status: true } });
}
export function lockCheckoutBooking(manager: EntityManager, id: string) {
  return manager.getRepository(CheckoutRecordEntity).createQueryBuilder("booking")
    .where("booking.id = :id", { id }).setLock("pessimistic_write").getOne();
}
export async function discoverBookingLocation(manager: EntityManager, id: string) {
  return manager.getRepository(CheckoutRecordEntity).createQueryBuilder("b")
    .innerJoin(CourtReservationEntity, "r", "r.id=b.reservationId")
    .innerJoin(CourtEntity, "c", "c.id=r.courtId").select("c.locationId", "location_id").addSelect("r.coachUserId", "coach_user_id")
    .where("b.id=:id", { id }).getRawOne<{ location_id: string; coach_user_id: string | null }>();
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
export async function updateSettlementBookingStatus(manager: EntityManager, id: string, status: CheckoutRecordEntity["status"]) {
  await manager.getRepository(CheckoutRecordEntity).update(id, { status, updatedAt: new Date() });
}
// Owner-scoped read: another account's booking is indistinguishable from a missing one.
export async function findOwnedBookingRevision(manager: EntityManager, id: string, accountUserId: string) {
  const booking = await manager.getRepository(CheckoutRecordEntity).findOneBy({ id, accountUserId });
  return booking ? { status: booking.status, revision: await findRevision(manager, booking.currentRevisionId) } : null;
}
