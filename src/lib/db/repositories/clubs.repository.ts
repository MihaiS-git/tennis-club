import "server-only";

import { Brackets, In, IsNull, Not, type EntityManager } from "typeorm";
import { z } from "zod";

import { addDays } from "@/lib/courts/local-time";

import { OpeningHoursScheduleEntity } from "../entities/opening-hours-schedule.entity";
import { LocationEntity } from "../entities/location.entity";
import { CourtEntity } from "../entities/court.entity";
import { CourtCoveragePeriodEntity } from "../entities/court-coverage-period.entity";
import { LocationOpeningHoursEntity } from "../entities/location-opening-hours.entity";

// Transaction-scoped advisory fence preserves configuration/booking serialization
// without a coordination table or trigger. Acquire before ordered location locks.
// The two-integer key is reserved for this application's configuration protocol.
export async function lockConfigurationForWrite(manager: EntityManager): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock(1791462257, 1)");
}

export async function lockLocations(manager: EntityManager, ids: readonly string[]): Promise<LocationEntity[]> {
  if (!ids.length) return [];
  return manager.getRepository(LocationEntity).createQueryBuilder("location")
    .where({ id: In([...new Set(ids.map((id) => id.toLowerCase()))]) })
    .orderBy("location.id", "ASC")
    .setLock("pessimistic_write")
    .getMany();
}

export async function listAdminLocations(manager: EntityManager, view: "current" | "archived") {
  return manager.getRepository(LocationEntity).find({
    where: { archivedAt: view === "archived" ? Not(IsNull()) : IsNull() },
    order: { displayOrder: "ASC", name: "ASC", id: "ASC" },
  });
}

export type LocationFields = Pick<LocationEntity,
  "name" | "addressLine1" | "addressLine2" | "city" | "postalCode" | "countryCode"
  | "timezone" | "currency" | "isActive" | "isPublic" | "displayOrder"
  | "customerCancellationNoticeMinutes" | "allowPayAtClub"
>;

function locationValues(fields: LocationFields, updatedAt: Date) {
  return {
    name: fields.name, addressLine1: fields.addressLine1, addressLine2: fields.addressLine2,
    city: fields.city, postalCode: fields.postalCode, countryCode: fields.countryCode,
    timezone: fields.timezone, currency: fields.currency, isActive: fields.isActive,
    isPublic: fields.isPublic, displayOrder: fields.displayOrder,
    customerCancellationNoticeMinutes: fields.customerCancellationNoticeMinutes,
    allowPayAtClub: fields.allowPayAtClub, updatedAt,
  };
}

const returnedIds = z.array(z.object({ id: z.uuid() }));

export async function insertLocation(manager: EntityManager, fields: LocationFields, slug: string, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(LocationEntity)
    .values({ ...locationValues(fields, updatedAt), slug }).returning("id").execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function updateUnarchivedLocation(manager: EntityManager, id: string, fields: LocationFields, updatedAt: Date) {
  const result = await manager.createQueryBuilder().update(LocationEntity)
    .set(locationValues(fields, updatedAt)).where({ id, archivedAt: IsNull() })
    .returning("id").updateEntity(false).execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

// Live occupancy facts from the location-local date onward, plus every hold. Earlier
// dates have ended; the location service decides which remaining rows are unfinished.
export async function listLocationLiveOccupancy(manager: EntityManager, locationId: string, fromDate: string) {
  const rows: unknown = await manager.query(`SELECT r.status::text AS status, r.booking_date::text AS date,
      r.ends_at_minute AS end_minute, b.id IS NOT NULL AS booked, r.coach_user_id IS NOT NULL AS coaching
    FROM public.court_reservations r JOIN public.courts c ON c.id=r.court_id
    LEFT JOIN public.bookings b ON b.reservation_id=r.id
    WHERE c.location_id=$1 AND (r.status='held' OR (r.status='active' AND r.booking_date>=$2::date))`, [locationId, fromDate]);
  return z.array(z.object({ status: z.enum(["active", "held"]), date: z.iso.date(), end_minute: z.number().int(),
    booked: z.boolean(), coaching: z.boolean() })).parse(rows);
}

export async function setLocationArchived(manager: EntityManager, id: string, archived: boolean, updatedAt: Date) {
  const result = await manager.createQueryBuilder().update(LocationEntity)
    .set({ archivedAt: archived ? updatedAt : null, isActive: false, updatedAt })
    .where({ id, archivedAt: archived ? IsNull() : Not(IsNull()) })
    .returning("id").updateEntity(false).execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function listAdminCourts(manager: EntityManager, locationId?: string) {
  return manager.getRepository(CourtEntity).find({
    where: locationId ? { locationId } : {},
    order: { name: "ASC", id: "ASC" },
  });
}

export async function findCourtConfiguration(manager: EntityManager, id: string) {
  return manager.getRepository(CourtEntity).findOne({
    where: { id }, select: { id: true, locationId: true, environment: true },
  });
}

export type CourtFields = Pick<CourtEntity,
  "locationId" | "name" | "surface" | "environment" | "hasLighting" | "isActive"
>;

function courtValues(fields: CourtFields, updatedAt: Date) {
  return {
    locationId: fields.locationId, name: fields.name, surface: fields.surface,
    environment: fields.environment, hasLighting: fields.hasLighting,
    isActive: fields.isActive, updatedAt,
  };
}

export async function insertCourt(manager: EntityManager, fields: CourtFields, slug: string, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(CourtEntity)
    .values({ ...courtValues(fields, updatedAt), slug }).returning("id").execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function updateCourt(manager: EntityManager, id: string, fields: CourtFields, updatedAt: Date) {
  const result = await manager.createQueryBuilder().update(CourtEntity)
    .set(courtValues(fields, updatedAt)).where({ id })
    .returning("id").updateEntity(false).execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function listCourtCoverage(manager: EntityManager, courtId?: string, locationId?: string) {
  return manager.getRepository(CourtCoveragePeriodEntity).find({
    where: { ...(courtId ? { courtId } : {}), ...(locationId ? { court: { locationId } } : {}) },
    select: { id: true, courtId: true, startsOn: true, endsOn: true, createdAt: true, updatedAt: true },
    order: { startsOn: "ASC", id: "ASC" },
  });
}

export type CoverageDates = Pick<CourtCoveragePeriodEntity, "startsOn" | "endsOn">;

export async function insertCourtCoverage(manager: EntityManager, courtId: string, dates: CoverageDates, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(CourtCoveragePeriodEntity)
    .values({ courtId, startsOn: dates.startsOn, endsOn: dates.endsOn, updatedAt })
    .returning("id").execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function updateCourtCoverage(manager: EntityManager, id: string, courtId: string, dates: CoverageDates, updatedAt: Date) {
  const result = await manager.createQueryBuilder().update(CourtCoveragePeriodEntity)
    .set({ startsOn: dates.startsOn, endsOn: dates.endsOn, updatedAt }).where({ id, courtId })
    .returning("id").updateEntity(false).execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function deleteCourtCoverage(manager: EntityManager, id: string, courtId: string) {
  const result = await manager.createQueryBuilder().delete().from(CourtCoveragePeriodEntity)
    .where({ id, courtId }).returning("id").execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function listLocationOpeningHoursFacts(manager: EntityManager, locationId: string) {
  return manager.getRepository(LocationOpeningHoursEntity).find({
    where: { locationId }, select: { id: true, scheduleId: true, weekday: true, opensAtMinute: true, closesAtMinute: true },
  });
}

export async function listActiveLocationCourts(manager: EntityManager, locationId: string) {
  return manager.getRepository(CourtEntity).find({
    where: { locationId, isActive: true }, select: { id: true, environment: true },
  });
}

export async function listLocationOpeningHours(manager: EntityManager, locationId?: string, date?: string) {
  const query = manager.getRepository(LocationOpeningHoursEntity).createQueryBuilder("h")
    .innerJoin(OpeningHoursScheduleEntity, "s", "s.id = h.schedule_id");
  if (locationId) query.andWhere("h.location_id = :locationId", { locationId });
  if (date) query.andWhere("s.starts_on <= :date AND (s.ends_on IS NULL OR s.ends_on >= :date)", { date });
  return query.orderBy("h.location_id").addOrderBy("h.weekday").addOrderBy("h.opens_at_minute").addOrderBy("h.id").getMany();
}

export async function readOpeningHoursConfigurationTime(manager: EntityManager): Promise<Date> {
  const rows: unknown = await manager.query("SELECT clock_timestamp() AS now");
  return z.array(z.object({ now: z.date() })).length(1).parse(rows)[0].now;
}

export async function deleteSelectedOpeningHours(manager: EntityManager, locationId: string, ids: readonly string[]) {
  await manager.getRepository(LocationOpeningHoursEntity).delete({ locationId, id: In([...ids]) });
}

export type OpeningHoursFields = Pick<LocationOpeningHoursEntity,
  "locationId" | "weekday" | "opensAtMinute" | "closesAtMinute"
>;

export async function insertOpeningHours(manager: EntityManager, rows: readonly (OpeningHoursFields & { scheduleId: string })[]) {
  if (!rows.length) return;
  await manager.createQueryBuilder().insert().into(LocationOpeningHoursEntity)
    .values(rows.map((row) => ({ locationId: row.locationId, scheduleId: row.scheduleId, weekday: row.weekday,
      opensAtMinute: row.opensAtMinute, closesAtMinute: row.closesAtMinute })))
    .updateEntity(false).execute();
}

export async function lockConfigurationForRead(manager: EntityManager): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock_shared(1791462257, 1)");
}

export async function lockLocationsForRead(manager: EntityManager, ids: readonly string[]): Promise<LocationEntity[]> {
  if (!ids.length) return [];
  return manager.getRepository(LocationEntity).createQueryBuilder("location")
    .where({ id: In([...new Set(ids.map((id) => id.toLowerCase()))]) }).orderBy("location.id", "ASC")
    .setLock("pessimistic_read").getMany();
}

export async function listCheckoutLocationCourts(manager: EntityManager, locationId: string) {
  return manager.getRepository(CourtEntity).find({
    where: { locationId, isActive: true },
    select: { id: true, name: true, slug: true, surface: true, environment: true, hasLighting: true },
    order: { id: "ASC" },
  });
}

export async function listCheckoutCourtCoverage(manager: EntityManager, courtId: string, date: string) {
  return manager.getRepository(CourtCoveragePeriodEntity).createQueryBuilder("coverage")
    .where("coverage.court_id = :courtId AND coverage.starts_on <= :date AND coverage.ends_on >= :date", { courtId, date })
    .getMany();
}

export async function listBookingEditDayCoverage(manager: EntityManager, locationId: string, courtIds: string[], date: string) {
  if (!courtIds.length) return [];
  return manager.getRepository(CourtCoveragePeriodEntity).createQueryBuilder("coverage")
    .innerJoin(CourtEntity, "court", "court.id = coverage.court_id AND court.location_id = :locationId", { locationId })
    .where("coverage.court_id IN (:...courtIds)", { courtIds })
    .andWhere("coverage.starts_on <= :date AND coverage.ends_on >= :date", { date })
    .orderBy("coverage.court_id", "ASC").addOrderBy("coverage.id", "ASC")
    .getMany();
}

// Public projections explicitly enforce the visibility previously supplied by JWT RLS.
export async function listPublicLocationFacts(manager: EntityManager, now = new Date()): Promise<unknown> {
  return readPublicLocationFacts(manager, now);
}

export async function listPublicLocationFactsForLocation(manager: EntityManager, locationId: string, now = new Date()): Promise<unknown> {
  return readPublicLocationFacts(manager, now, locationId);
}

async function readPublicLocationFacts(manager: EntityManager, now: Date, locationId?: string): Promise<unknown> {
  // UTC yesterday is no later than any location's local today. This removes old
  // history without duplicating TypeScript timezone validation/publication rules.
  // Keep the adjacent-date guard and every future period, including open-ended ones.
  const earliestDate = addDays(now.toISOString().slice(0, 10), -1);
  const dateParameter = locationId === undefined ? "$1" : "$2";
  return manager.query(`SELECT l.id,l.name,l.slug,l.address_line1,l.address_line2,l.city,l.postal_code,
    l.country_code,l.timezone,l.currency,l.allow_pay_at_club,l.customer_cancellation_notice_minutes,l.is_active,l.is_public,
    l.archived_at::text AS archived_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id,'weekday',h.weekday,'opens_at_minute',h.opens_at_minute,'closes_at_minute',h.closes_at_minute,'starts_on',s.starts_on,'ends_on',s.ends_on,'schedule_id',s.id)) FROM public.location_opening_hours h JOIN public.opening_hours_schedules s ON s.id=h.schedule_id
      WHERE h.location_id=l.id AND s.location_id=l.id
        AND daterange(s.starts_on,s.ends_on,'[]') && daterange(${dateParameter}::date,NULL,'[]')),'[]'::jsonb) AS location_opening_hours,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'slug',c.slug,
      'surface',c.surface,'environment',c.environment,'has_lighting',c.has_lighting,'is_active',c.is_active,
      'location_pricing_rules',coalesce((SELECT jsonb_agg(jsonb_build_object('court_state',p.court_state,
        'ends_on',p.ends_on,'starts_on',p.starts_on,'weekday',p.weekday,'starts_at_minute',p.starts_at_minute,'ends_at_minute',p.ends_at_minute)) FROM public.location_pricing_rules p WHERE p.court_id=c.id
          AND daterange(p.starts_on,p.ends_on,'[]') && daterange(${dateParameter}::date,NULL,'[]')),'[]'::jsonb))
      ORDER BY c.name,c.id) FROM public.courts c WHERE c.location_id=l.id AND c.is_active),'[]'::jsonb) AS courts
    FROM public.locations l WHERE l.is_active AND l.archived_at IS NULL AND l.is_public
    ${locationId === undefined ? "" : "AND l.id=$1"}
    ORDER BY l.display_order,l.name,l.id`, locationId === undefined ? [earliestDate] : [locationId, earliestDate]);
}

// One entry per public location, each with its own local date and weekday.
export type PublicDayRead = { locationId: string; courtIds: readonly string[]; weekday: number; date: string };

const publicDayRows = z.array(z.object({ row: z.unknown() }));

export async function listPublicDayOpeningHours(manager: EntityManager, days: readonly PublicDayRead[]): Promise<unknown> {
  if (!days.length) return [];
  const rows: unknown = await manager.getRepository(LocationOpeningHoursEntity).createQueryBuilder("h")
    .select("to_jsonb(h)", "row")
    .innerJoin(OpeningHoursScheduleEntity, "s", "s.id = h.schedule_id")
    .innerJoin(LocationEntity, "l", "l.id = h.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public")
    .where(new Brackets((query) => days.forEach((day, index) => query.orWhere(
      `(h.location_id = :location${index} AND h.weekday = :weekday${index} AND s.starts_on <= :date${index}
        AND (s.ends_on IS NULL OR s.ends_on >= :date${index}))`,
      { [`location${index}`]: day.locationId, [`weekday${index}`]: day.weekday, [`date${index}`]: day.date }))))
    .getRawMany();
  return publicDayRows.parse(rows).map(({ row }) => row);
}

export async function listPublicDayCoverage(manager: EntityManager, days: readonly PublicDayRead[]): Promise<unknown> {
  const withCourts = days.filter((day) => day.courtIds.length);
  if (!withCourts.length) return [];
  const rows: unknown = await manager.getRepository(CourtCoveragePeriodEntity).createQueryBuilder("p")
    .select("to_jsonb(p)", "row")
    .innerJoin(CourtEntity, "c", "c.id = p.court_id AND c.is_active")
    .innerJoin(LocationEntity, "l", "l.id = c.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public")
    .where(new Brackets((query) => withCourts.forEach((day, index) => query.orWhere(
      `(l.id = :location${index} AND p.court_id IN (:...courts${index}) AND p.starts_on <= :date${index}
        AND (p.ends_on IS NULL OR p.ends_on >= :date${index}))`,
      { [`location${index}`]: day.locationId, [`courts${index}`]: [...day.courtIds], [`date${index}`]: day.date }))))
    .getRawMany();
  return publicDayRows.parse(rows).map(({ row }) => row);
}

// Admin-only caller supplies authorized location IDs; includes unpublished/archived resources.
export async function listAdminPublicationFacts(manager: EntityManager, locationIds: string[]): Promise<unknown> {
  if (!locationIds.length) return [];
  return manager.query(`SELECT l.id,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id,'weekday',h.weekday,'opens_at_minute',h.opens_at_minute,'closes_at_minute',h.closes_at_minute,'starts_on',s.starts_on,'ends_on',s.ends_on,'schedule_id',s.id)) FROM public.location_opening_hours h JOIN public.opening_hours_schedules s ON s.id=h.schedule_id
      WHERE h.location_id=l.id),'[]'::jsonb) AS location_opening_hours,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'environment',c.environment,
      'location_pricing_rules',coalesce((SELECT jsonb_agg(jsonb_build_object('court_state',p.court_state,
        'ends_on',p.ends_on,'starts_on',p.starts_on,'weekday',p.weekday,'starts_at_minute',p.starts_at_minute,'ends_at_minute',p.ends_at_minute)) FROM public.location_pricing_rules p WHERE p.court_id=c.id),'[]'::jsonb)))
      FROM public.courts c WHERE c.location_id=l.id AND c.is_active),'[]'::jsonb) AS courts
    FROM public.locations l WHERE l.id=ANY($1::uuid[])`, [locationIds]);
}

export async function setLocationPublication(manager: EntityManager, id: string, isPublic: boolean, updatedAt: Date) {
  await manager.getRepository(LocationEntity).update({ id }, { isPublic, updatedAt });
}

export async function findAdminLocation(manager: EntityManager, id: string) {
  return manager.getRepository(LocationEntity).findOne({ where: { id } });
}

export async function listOpeningHoursSchedules(manager: EntityManager, locationId: string) {
  return manager.getRepository(OpeningHoursScheduleEntity).find({ where: { locationId }, order: { startsOn: "ASC", id: "ASC" } });
}
export async function saveOpeningHoursSchedule(manager: EntityManager, input: {
  locationId: string; startsOn: string; endsOn: string | null;
} & ({ id: string; revision: number } | { id?: undefined; revision?: undefined })) {
  if (input.id) {
    await manager.getRepository(OpeningHoursScheduleEntity).update({ id: input.id, locationId: input.locationId },
      { startsOn: input.startsOn, endsOn: input.endsOn, revision: input.revision + 1 });
    return input.id;
  }
  const result = await manager.createQueryBuilder().insert().into(OpeningHoursScheduleEntity)
    .values({ locationId: input.locationId, startsOn: input.startsOn, endsOn: input.endsOn }).returning("id").execute();
  return returnedIds.parse(result.raw)[0].id;
}
export async function deleteOpeningHoursSchedule(manager: EntityManager, locationId: string, id: string) {
  await manager.getRepository(OpeningHoursScheduleEntity).delete({ id, locationId });
}
