import "server-only";

import { In, IsNull, Not, type EntityManager } from "typeorm";
import { z } from "zod";

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

export async function setLocationArchived(manager: EntityManager, id: string, archived: boolean, updatedAt: Date) {
  const result = await manager.createQueryBuilder().update(LocationEntity)
    .set({ archivedAt: archived ? updatedAt : null, isActive: false, updatedAt })
    .where({ id, archivedAt: archived ? IsNull() : Not(IsNull()) })
    .returning("id").updateEntity(false).execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

export async function listAdminCourts(manager: EntityManager) {
  return manager.getRepository(CourtEntity).find({ order: { name: "ASC", id: "ASC" } });
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

export async function listCourtCoverage(manager: EntityManager, courtId?: string) {
  return manager.getRepository(CourtCoveragePeriodEntity).find({
    where: courtId ? { courtId } : {},
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
    where: { locationId }, select: { id: true },
  });
}

export async function listActiveLocationCourts(manager: EntityManager, locationId: string) {
  return manager.getRepository(CourtEntity).find({
    where: { locationId, isActive: true }, select: { id: true, environment: true },
  });
}

export async function listLocationOpeningHours(manager: EntityManager, locationId?: string) {
  return manager.getRepository(LocationOpeningHoursEntity).find({
    where: locationId ? { locationId } : {},
    order: { locationId: "ASC", weekday: "ASC", opensAtMinute: "ASC", id: "ASC" },
  });
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

export async function insertOpeningHours(manager: EntityManager, rows: readonly OpeningHoursFields[]) {
  if (!rows.length) return;
  await manager.createQueryBuilder().insert().into(LocationOpeningHoursEntity)
    .values(rows.map((row) => ({ locationId: row.locationId, weekday: row.weekday,
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

export async function findLocationCancellationNotice(manager: EntityManager, id: string) {
  return manager.getRepository(LocationEntity).findOne({
    where: { id }, select: { customerCancellationNoticeMinutes: true },
  });
}

// Public projections explicitly enforce the visibility previously supplied by JWT RLS.
export async function listPublicLocationFacts(manager: EntityManager): Promise<unknown> {
  return manager.query(`SELECT l.id,l.name,l.slug,l.address_line1,l.address_line2,l.city,l.postal_code,
    l.country_code,l.timezone,l.currency,l.allow_pay_at_club,l.is_active,l.is_public,
    l.archived_at::text AS archived_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id)) FROM public.location_opening_hours h
      WHERE h.location_id=l.id),'[]'::jsonb) AS location_opening_hours,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'slug',c.slug,
      'surface',c.surface,'environment',c.environment,'has_lighting',c.has_lighting,'is_active',c.is_active,
      'location_pricing_rules',coalesce((SELECT jsonb_agg(jsonb_build_object('court_state',p.court_state,
        'ends_on',p.ends_on)) FROM public.location_pricing_rules p WHERE p.court_id=c.id),'[]'::jsonb))
      ORDER BY c.name,c.id) FROM public.courts c WHERE c.location_id=l.id AND c.is_active),'[]'::jsonb) AS courts
    FROM public.locations l WHERE l.is_active AND l.archived_at IS NULL AND l.is_public
    ORDER BY l.display_order,l.name,l.id`);
}

export async function listPublicDayOpeningHours(manager: EntityManager, locationId: string, weekday: number): Promise<unknown> {
  const rows: unknown = await manager.query(`SELECT to_jsonb(h) AS row FROM public.location_opening_hours h
    JOIN public.locations l ON l.id=h.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public
    WHERE h.location_id=$1 AND h.weekday=$2`, [locationId,weekday]);
  return z.array(z.object({ row: z.unknown() })).parse(rows).map(({ row }) => row);
}

export async function listPublicDayCoverage(manager: EntityManager, locationId: string, courtIds: string[], date: string): Promise<unknown> {
  const rows: unknown = await manager.query(`SELECT to_jsonb(p) AS row FROM public.court_coverage_periods p
    JOIN public.courts c ON c.id=p.court_id AND c.is_active
    JOIN public.locations l ON l.id=c.location_id AND l.is_active AND l.archived_at IS NULL AND l.is_public
    WHERE l.id=$1 AND p.court_id=ANY($2::uuid[]) AND p.starts_on<=$3::date
      AND (p.ends_on IS NULL OR p.ends_on>=$3::date)`, [locationId,courtIds,date]);
  return z.array(z.object({ row: z.unknown() })).parse(rows).map(({ row }) => row);
}

// Admin-only caller supplies authorized location IDs; includes unpublished/archived resources.
export async function listAdminPublicationFacts(manager: EntityManager, locationIds: string[]): Promise<unknown> {
  if (!locationIds.length) return [];
  return manager.query(`SELECT l.id,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',h.id)) FROM public.location_opening_hours h
      WHERE h.location_id=l.id),'[]'::jsonb) AS location_opening_hours,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'environment',c.environment,
      'location_pricing_rules',coalesce((SELECT jsonb_agg(jsonb_build_object('court_state',p.court_state,
        'ends_on',p.ends_on)) FROM public.location_pricing_rules p WHERE p.court_id=c.id),'[]'::jsonb)))
      FROM public.courts c WHERE c.location_id=l.id AND c.is_active),'[]'::jsonb) AS courts
    FROM public.locations l WHERE l.id=ANY($1::uuid[])`, [locationIds]);
}

export async function setLocationPublication(manager: EntityManager, id: string, isPublic: boolean, updatedAt: Date) {
  await manager.getRepository(LocationEntity).update({ id }, { isPublic, updatedAt });
}

export async function findAdminLocation(manager: EntityManager, id: string) {
  return manager.getRepository(LocationEntity).findOne({ where: { id } });
}
