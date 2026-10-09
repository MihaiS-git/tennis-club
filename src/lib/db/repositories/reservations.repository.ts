import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { CourtReservationEntity } from "../entities/court-reservation.entity";

// Casting before pg hydration preserves microseconds. PostgreSQL's timestamp
// text trims fractional zeros, matching PostgREST's UTC timestamptz tokens.
function timestamp(column: string) {
  return `replace((${column} AT TIME ZONE 'UTC')::text, ' ', 'T') || '+00:00'`;
}
const instant = z.iso.datetime({ offset: true });
const reservationSchema = z.object({
  id: z.uuid(), court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  reason: z.string().nullable(), created_by_user_id: z.uuid().nullable(),
  status: z.enum(["active", "cancelled", "held", "released"]),
  created_at: instant, updated_at: instant, cancelled_at: instant.nullable(),
  cancelled_by_user_id: z.uuid().nullable(), hold_expires_at: instant.nullable(),
});
const resourceSchema = z.object({
  court_id: z.uuid(), court_name: z.string(), court_active: z.boolean(),
  location_id: z.uuid(), location_name: z.string(), location_timezone: z.string(),
  location_active: z.boolean(), archived_at: instant.nullable(),
});
const projection = `r.id, r.court_id, r.booking_date::text, r.starts_at_minute, r.ends_at_minute,
  r.reason, r.created_by_user_id, r.status, ${timestamp("r.created_at")} AS created_at,
  ${timestamp("r.updated_at")} AS updated_at, ${timestamp("r.cancelled_at")} AS cancelled_at,
  r.cancelled_by_user_id, ${timestamp("r.hold_expires_at")} AS hold_expires_at`;
const resources = `c.id AS court_id, c.name AS court_name, c.is_active AS court_active,
  l.id AS location_id, l.name AS location_name, l.timezone AS location_timezone,
  l.is_active AS location_active, ${timestamp("l.archived_at")} AS archived_at`;

export async function findReservationParent(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    `SELECT c.location_id FROM public.court_reservations r
     JOIN public.courts c ON c.id = r.court_id WHERE r.id = $1`, [id],
  );
  return z.array(z.object({ location_id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

export async function findReservationForUpdate(manager: EntityManager, id: string, expectedUpdatedAt?: string, skipLocked = false) {
  const rows: unknown = await manager.query(
    `SELECT ${projection}, r.updated_at = $2::timestamptz AS token_matches
     FROM public.court_reservations r WHERE r.id = $1 FOR UPDATE OF r${skipLocked ? " SKIP LOCKED" : ""}`,
    [id, expectedUpdatedAt ?? null],
  );
  return z.array(reservationSchema.extend({ token_matches: z.boolean().nullable() })).max(1).parse(rows)[0] ?? null;
}

export async function findReservationResourceFacts(manager: EntityManager, courtId: string) {
  const rows: unknown = await manager.query(
    `SELECT ${resources} FROM public.courts c JOIN public.locations l ON l.id = c.location_id
     WHERE c.id = $1`, [courtId],
  );
  return z.array(resourceSchema).max(1).parse(rows)[0] ?? null;
}

export async function hasCustomerBookingLink(manager: EntityManager, id: string): Promise<boolean> {
  const rows: unknown = await manager.query(
    "SELECT EXISTS(SELECT 1 FROM public.bookings WHERE reservation_id = $1) AS linked", [id],
  );
  return z.array(z.object({ linked: z.boolean() })).length(1).parse(rows)[0].linked;
}

export async function listReservationOpeningHours(manager: EntityManager, locationId: string, date: string) {
  const rows: unknown = await manager.query(
    `SELECT id, location_id, weekday, opens_at_minute, closes_at_minute,
     ${timestamp("created_at")} AS created_at, ${timestamp("updated_at")} AS updated_at
     FROM public.location_opening_hours WHERE location_id = $1 AND weekday = $2
     ORDER BY opens_at_minute, id`, [locationId, mondayWeekday(date)],
  );
  return z.array(openingIntervalSchema).parse(rows);
}

export async function findDirectReservationTargetFacts(manager: EntityManager, locationId: string, courtId: string, date: string) {
  const resource = await findReservationResourceFacts(manager, courtId);
  const hours = await listReservationOpeningHours(manager, locationId, date);
  return { resource, hours };
}

export async function insertDirectReservation(manager: EntityManager, input: {
  courtId: string; date: string; startMinute: number; endMinute: number; reason: string; actorId: string;
}) {
  await manager.createQueryBuilder().insert().into(CourtReservationEntity).values({
    courtId: input.courtId, bookingDate: input.date, startsAtMinute: input.startMinute,
    endsAtMinute: input.endMinute, reason: input.reason, createdByUserId: input.actorId,
  }).updateEntity(false).execute();
}

export async function updateDirectReservationReason(manager: EntityManager, id: string, reason: string) {
  await manager.query(
    `UPDATE public.court_reservations SET reason = $2,
     updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') WHERE id = $1`, [id, reason],
  );
}

export async function updateDirectReservationSchedule(manager: EntityManager, id: string, input: {
  courtId: string; date: string; startMinute: number; endMinute: number; reason: string;
}) {
  await manager.query(
    `UPDATE public.court_reservations SET court_id = $2, booking_date = $3,
     starts_at_minute = $4, ends_at_minute = $5, reason = $6,
     updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond') WHERE id = $1`,
    [id, input.courtId, input.date, input.startMinute, input.endMinute, input.reason],
  );
}

export async function cancelDirectReservation(manager: EntityManager, id: string, actorId: string, checkedAt: string) {
  await manager.query(
    `UPDATE public.court_reservations SET status = 'cancelled', cancelled_at = $3::timestamptz,
     cancelled_by_user_id = $2, updated_at = $3::timestamptz WHERE id = $1`, [id, actorId, checkedAt],
  );
}

export async function readReservationTransactionTime(manager: EntityManager): Promise<string> {
  const rows: unknown = await manager.query(`SELECT ${timestamp("now()")} AS instant`);
  return z.array(z.object({ instant })).length(1).parse(rows)[0].instant;
}

export async function readReservationClockTime(manager: EntityManager): Promise<string> {
  const rows: unknown = await manager.query(`SELECT ${timestamp("clock_timestamp()")} AS instant`);
  return z.array(z.object({ instant })).length(1).parse(rows)[0].instant;
}

export async function findReservationOccupancy(manager: EntityManager, scope: { courtIds: string[] } | { locationId: string },
  date: string, offset: number, limit: number, excludeReservationId?: string) {
  if ("courtIds" in scope && !scope.courtIds.length) return [];
  const rows: unknown = await manager.query(
    `SELECT r.court_id, r.starts_at_minute, r.ends_at_minute, r.status,
     ${timestamp("r.hold_expires_at")} AS hold_expires_at FROM public.court_reservations r
     JOIN public.courts c ON c.id = r.court_id AND c.is_active
     JOIN public.locations l ON l.id = c.location_id AND l.is_active AND l.archived_at IS NULL
     WHERE r.booking_date = $1 AND r.status IN ('active', 'held')
       AND ${"courtIds" in scope ? "r.court_id = ANY($2::uuid[])" : "c.location_id = $2::uuid"}
       AND ($3::uuid IS NULL OR r.id <> $3)
     ORDER BY r.court_id, r.starts_at_minute, r.id OFFSET $4 LIMIT $5`,
    [date, "courtIds" in scope ? scope.courtIds : scope.locationId, excludeReservationId ?? null, offset, limit],
  );
  return z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    status: z.enum(["active", "held"]), hold_expires_at: instant.nullable() })).parse(rows);
}

export async function findReservationEditContext(manager: EntityManager, id: string, ownerId?: string) {
  const rows: unknown = await manager.query(
    `SELECT ${projection}, ${resources} FROM public.court_reservations r
     JOIN public.courts c ON c.id = r.court_id AND c.is_active
     JOIN public.locations l ON l.id = c.location_id AND l.is_active AND l.archived_at IS NULL
     WHERE r.id = $1 AND r.status = 'active'
       AND ($2::uuid IS NULL OR r.created_by_user_id = $2)
       AND NOT EXISTS(SELECT 1 FROM public.bookings b WHERE b.reservation_id = r.id)`, [id, ownerId ?? null],
  );
  return z.array(reservationSchema.extend(resourceSchema.shape)).max(1).parse(rows)[0] ?? null;
}

export async function findReservationEditLocation(manager: EntityManager, locationId: string) {
  const rows: unknown = await manager.query(
    `SELECT l.id, l.name, l.timezone, l.is_active, ${timestamp("l.archived_at")} AS archived_at,
     coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_active', c.is_active))
       FROM public.courts c WHERE c.location_id = l.id AND c.is_active), '[]'::jsonb) AS courts
     FROM public.locations l WHERE l.id = $1`, [locationId],
  );
  return z.array(z.object({ id: z.uuid(), name: z.string(), timezone: z.string(), is_active: z.boolean(),
    archived_at: instant.nullable(), courts: z.array(z.object({ id: z.uuid(), name: z.string(), is_active: z.boolean() })),
  })).max(1).parse(rows)[0] ?? null;
}

export async function listInternalReservationLocations(manager: EntityManager) {
  const rows: unknown = await manager.query(
    `SELECT l.id, l.name, l.slug, l.timezone, l.currency, l.is_active, l.is_public,
     ${timestamp("l.archived_at")} AS archived_at,
     coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id)) FROM public.location_opening_hours h
       WHERE h.location_id = l.id), '[]'::jsonb) AS location_opening_hours,
     coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'environment', c.environment,
       'is_active', c.is_active, 'location_pricing_rules',
       coalesce((SELECT jsonb_agg(jsonb_build_object('court_state', p.court_state, 'ends_on', p.ends_on))
         FROM public.location_pricing_rules p WHERE p.court_id = c.id), '[]'::jsonb)) ORDER BY c.name, c.id)
       FROM public.courts c WHERE c.location_id = l.id AND c.is_active), '[]'::jsonb) AS courts
     FROM public.locations l WHERE l.is_active AND l.archived_at IS NULL ORDER BY l.display_order, l.name, l.id`,
  );
  return z.array(z.object({ id: z.uuid(), name: z.string(), slug: z.string(), timezone: z.string(), currency: z.string(),
    is_active: z.boolean(), is_public: z.boolean(), archived_at: instant.nullable(),
    location_opening_hours: z.array(z.object({ id: z.uuid() })),
    courts: z.array(z.object({ id: z.uuid(), name: z.string(), environment: z.enum(["indoor", "outdoor"]),
      is_active: z.boolean(), location_pricing_rules: z.array(z.object({
        court_state: z.enum(["indoor", "outdoor", "covered"]), ends_on: z.iso.date().nullable(),
      })) })),
  })).parse(rows);
}

export async function insertCustomerReservation(manager: EntityManager, input: {
  id: string; courtId: string; date: string; startMinute: number; endMinute: number;
  status: "active" | "held"; holdExpiresAt: string | null;
}) {
  await manager.query(
    `INSERT INTO public.court_reservations
     (id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    [input.id, input.courtId, input.date, input.startMinute, input.endMinute, input.status, input.holdExpiresAt],
  );
}

export async function findCheckoutOccupancy(manager: EntityManager, courtId: string, date: string, excludeId?: string, checkedAt?: string) {
  const rows: unknown = await manager.query(
    `SELECT court_id,booking_date::text,starts_at_minute,ends_at_minute
     FROM public.court_reservations WHERE court_id=$1 AND booking_date=$2
       AND (status='active' OR (status='held' AND hold_expires_at > coalesce($4::timestamptz,statement_timestamp())))
       AND ($3::uuid IS NULL OR id<>$3)`, [courtId, date, excludeId ?? null, checkedAt ?? null],
  );
  return z.array(z.object({ court_id: z.uuid(), booking_date: z.iso.date(),
    starts_at_minute: z.number().int(), ends_at_minute: z.number().int() })).parse(rows);
}

export async function readCheckoutClock(manager: EntityManager, holdSeconds: number | null) {
  const rows: unknown = await manager.query(
    `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS checked_at)
     SELECT replace((checked_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS now,
       replace(((checked_at + make_interval(secs=>$1::integer)) AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS expiry
     FROM clock`, [holdSeconds],
  );
  return z.array(z.object({ now: instant, expiry: instant.nullable() })).length(1).parse(rows)[0];
}

export async function updateCustomerReservationCancellation(manager: EntityManager, id: string, actorId: string, checkedAt: string) {
  await manager.query(
    `UPDATE public.court_reservations SET status='cancelled',cancelled_at=$3::timestamptz,
     cancelled_by_user_id=$2,updated_at=$3::timestamptz WHERE id=$1`, [id, actorId, checkedAt]);
}

export async function updateCustomerReservationSchedule(manager: EntityManager, id: string, input: {
  courtId: string; date: string; startMinute: number; endMinute: number;
}) {
  await manager.query(
    `UPDATE public.court_reservations SET court_id=$2,booking_date=$3,starts_at_minute=$4,ends_at_minute=$5,
     updated_at=greatest(clock_timestamp(),updated_at + interval '1 microsecond') WHERE id=$1`,
    [id,input.courtId,input.date,input.startMinute,input.endMinute]);
}

export async function listCustomerEditOccupancy(manager: EntityManager, locationId: string, date: string, excludeId: string) {
  const rows: unknown = await manager.query(
    `SELECT r.court_id,r.starts_at_minute,r.ends_at_minute FROM public.court_reservations r
     JOIN public.courts c ON c.id=r.court_id AND c.is_active
     WHERE c.location_id=$1 AND r.booking_date=$2 AND r.id<>$3
       AND (r.status='active' OR (r.status='held' AND r.hold_expires_at>clock_timestamp()))
     ORDER BY r.court_id,r.starts_at_minute,r.id`, [locationId,date,excludeId]);
  return z.array(z.object({ court_id:z.uuid(),starts_at_minute:z.number().int(),ends_at_minute:z.number().int() })).parse(rows);
}


export async function updateSettlementReservationStatus(manager: EntityManager, id: string, status: string) {
  await manager.query("UPDATE public.court_reservations SET status=$2,hold_expires_at=NULL WHERE id=$1", [id,status]);
}

export async function findSettlementNotificationResource(manager: EntityManager, courtId: string) {
  const rows: unknown = await manager.query(
    `SELECT c.name AS court_name,l.name AS location_name,l.timezone
     FROM public.courts c JOIN public.locations l ON l.id=c.location_id WHERE c.id=$1`, [courtId]);
  return z.array(z.object({ court_name:z.string(),location_name:z.string(),timezone:z.string() })).length(1).parse(rows)[0];
}

export async function listPublicDayOccupancy(manager: EntityManager, locationId: string, courtIds: string[], date: string): Promise<unknown> {
  return manager.query(`SELECT r.court_id,r.booking_date::text,r.starts_at_minute,r.ends_at_minute
    FROM public.court_reservations r JOIN public.courts c ON c.id=r.court_id AND c.is_active
    JOIN public.locations l ON l.id=c.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public
    WHERE l.id=$1 AND r.court_id=ANY($2::uuid[]) AND r.booking_date=$3::date
      AND (r.status='active' OR (r.status='held' AND r.hold_expires_at>statement_timestamp()))`,
    [locationId,courtIds,date]);
}

// Application service authorizes active Admins before this private projection.
export async function listAdminOperationalProjection(manager: EntityManager, courtIds: string[], date: string): Promise<unknown> {
  return manager.query(`select case when b.id is null then 'reservation' else 'booking' end AS kind,
      coalesce(b.id, r.id) AS id, r.court_id, r.booking_date::text AS booking_date,
      r.starts_at_minute, r.ends_at_minute,
      case when b.id is null then r.reason else null end AS reason,
      case when b.id is null then r.created_by_user_id else null end AS created_by_user_id,
      case when b.id is null then nullif(concat_ws(' ', u.first_name, u.last_name), '') else null end AS creator_name,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
      coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from public.payment_attempts p where p.booking_id=b.id),'[]'::jsonb) AS payment_facts
    from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    left join public.bookings b on b.reservation_id = r.id
    left join public.users u on u.id = r.created_by_user_id and b.id is null
    where r.court_id = any($1::uuid[]) and r.booking_date = $2::date
      and r.status = 'active' and (b.id is null or b.status = 'confirmed');`, [courtIds,date]);
}
