import "server-only";

import { In, IsNull, type EntityManager } from "typeorm";
import { z } from "zod";

import { BookingRevisionEntity } from "../entities/booking-revision.entity";
import { CourtEntity } from "../entities/court.entity";
import { LocationEntity } from "../entities/location.entity";
import { CourtReservationEntity } from "../entities/court-reservation.entity";
import { CoachWeeklyAvailabilityEntity } from "../entities/coach-weekly-availability.entity";
import { CoachAvailabilityExceptionEntity } from "../entities/coach-availability-exception.entity";
import { CoachLocationEntity } from "../entities/coach-location.entity";
import { CoachProfileEntity } from "../entities/coach-profile.entity";
import { CoachProgramEntity } from "../entities/coach-program.entity";
import { CoachingPriceEntity } from "../entities/coaching-price.entity";
import { CoachingProgramDurationEntity } from "../entities/coaching-program-duration.entity";
import { CoachingProgramEntity } from "../entities/coaching-program.entity";
import { readIndependently } from "../transaction";

// ---- Programs ----

export async function listCoachingPrograms(manager: EntityManager) {
  const [programs, durations] = await readIndependently(manager, [
    () => manager.getRepository(CoachingProgramEntity).find({ order: { name: "ASC", id: "ASC" } }),
    () => manager.getRepository(CoachingProgramDurationEntity).find({ order: { durationMinutes: "ASC" } }),
  ]);
  return programs.map((program) => ({
    ...program,
    durations: durations.filter((duration) => duration.programId === program.id).map((duration) => duration.durationMinutes),
  }));
}

export async function lockCoachingProgram(manager: EntityManager, id: string, mode: "pessimistic_read" | "pessimistic_write") {
  const program = await manager.getRepository(CoachingProgramEntity).findOne({ where: { id: id.toLowerCase() }, lock: { mode } });
  if (!program) return null;
  const durations = await manager.getRepository(CoachingProgramDurationEntity)
    .find({ where: { programId: program.id }, order: { durationMinutes: "ASC" } });
  return { ...program, durations: durations.map((duration) => duration.durationMinutes) };
}

export async function lockCoachingProgramsForRead(manager: EntityManager, ids: readonly string[]) {
  if (!ids.length) return [];
  return manager.getRepository(CoachingProgramEntity).createQueryBuilder("program")
    .where({ id: In([...new Set(ids.map((id) => id.toLowerCase()))]) })
    .orderBy("program.id", "ASC").setLock("pessimistic_read").getMany();
}

export type CoachingProgramValues = Pick<CoachingProgramEntity,
  "name" | "description" | "programType" | "minParticipants" | "maxParticipants" | "courtRentalIncluded" | "isActive">;

const returnedIds = z.array(z.object({ id: z.uuid() }));

export async function insertCoachingProgram(manager: EntityManager, values: CoachingProgramValues, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(CoachingProgramEntity)
    .values({ ...values, updatedAt }).returning("id").execute();
  return returnedIds.parse(result.raw)[0].id;
}

export async function updateCoachingProgram(manager: EntityManager, id: string, values: Partial<CoachingProgramValues>, updatedAt: Date) {
  await manager.getRepository(CoachingProgramEntity).update({ id }, { ...values, updatedAt });
}

export async function addCoachingProgramDurations(manager: EntityManager, programId: string, durations: readonly number[]) {
  if (!durations.length) return;
  await manager.createQueryBuilder().insert().into(CoachingProgramDurationEntity)
    .values(durations.map((durationMinutes) => ({ programId, durationMinutes }))).execute();
}

export async function removeCoachingProgramDurations(manager: EntityManager, programId: string, durations: readonly number[]) {
  if (!durations.length) return;
  await manager.getRepository(CoachingProgramDurationEntity).delete({ programId, durationMinutes: In([...durations]) });
}

// ---- Coaches ----

const coachRowSchema = z.object({
  user_id: z.uuid(), display_name: z.string(), bio: z.string(), qualifications: z.string(),
  specialties: z.array(z.string()), languages: z.array(z.string()), is_public: z.boolean(),
  updated_at: z.string(), email: z.string(), account_status: z.enum(["active", "suspended"]), has_coach_role: z.boolean(),
  location_ids: z.array(z.uuid()), program_ids: z.array(z.uuid()),
});
export type CoachProfileRow = z.infer<typeof coachRowSchema>;

// Admin projection: includes the account email and role facts for eligibility.
export async function listCoachProfiles(manager: EntityManager): Promise<CoachProfileRow[]> {
  const rows: unknown = await manager.query(`SELECT c.user_id,c.display_name,c.bio,c.qualifications,c.specialties,c.languages,
    c.is_public,c.updated_at::text AS updated_at,u.email,u.status AS account_status,
    EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=c.user_id AND r.role_code='coach') AS has_coach_role,
    coalesce((SELECT array_agg(l.location_id ORDER BY l.location_id) FROM public.coach_locations l WHERE l.coach_user_id=c.user_id),'{}') AS location_ids,
    coalesce((SELECT array_agg(p.program_id ORDER BY p.program_id) FROM public.coach_programs p WHERE p.coach_user_id=c.user_id),'{}') AS program_ids
    FROM public.coach_profiles c JOIN public.users u ON u.id=c.user_id
    WHERE c.archived_at IS NULL
    ORDER BY lower(c.display_name),c.user_id`);
  return z.array(coachRowSchema).parse(rows);
}

const coachAccountSchema = z.object({ id: z.uuid(), email: z.string(), suggested_name: z.string().nullable() });

// Active coach-role accounts without a coaching profile yet.
export async function listCoachAccountsWithoutProfile(manager: EntityManager) {
  const rows: unknown = await manager.query(`SELECT u.id,u.email,
    coalesce(nullif(btrim(pp.display_name),''),nullif(btrim(concat_ws(' ',u.first_name,u.last_name)),'')) AS suggested_name
    FROM public.users u JOIN public.user_roles r ON r.user_id=u.id AND r.role_code='coach'
    LEFT JOIN public.player_profiles pp ON pp.user_id=u.id
    WHERE u.status='active' AND NOT EXISTS (SELECT 1 FROM public.coach_profiles c WHERE c.user_id=u.id)
    ORDER BY lower(u.email),u.id`);
  return z.array(coachAccountSchema).parse(rows);
}

// Unlocked read with assignments, for read-only projections.
export async function findCoachProfile(manager: EntityManager, userId: string) {
  const profile = await manager.getRepository(CoachProfileEntity).findOne({ where: { userId: userId.toLowerCase(), archivedAt: IsNull() } });
  if (!profile) return null;
  const locations = await manager.getRepository(CoachLocationEntity).find({ where: { coachUserId: profile.userId } });
  return { ...profile, locationIds: locations.map((row) => row.locationId) };
}

export async function lockCoachProfile(manager: EntityManager, userId: string, mode: "pessimistic_read" | "pessimistic_write") {
  const profile = await manager.getRepository(CoachProfileEntity).findOne({ where: { userId: userId.toLowerCase(), archivedAt: IsNull() }, lock: { mode } });
  if (!profile) return null;
  const [locations, programs] = await readIndependently(manager, [
    () => manager.getRepository(CoachLocationEntity).find({ where: { coachUserId: profile.userId } }),
    () => manager.getRepository(CoachProgramEntity).find({ where: { coachUserId: profile.userId } }),
  ]);
  return { ...profile, locationIds: locations.map((row) => row.locationId), programIds: programs.map((row) => row.programId) };
}

// Booking fence: shares the profile row that availability and assignment writes
// lock FOR UPDATE, before any location lock (their order). Row only, one query.
export async function lockCoachProfileForBooking(manager: EntityManager, userId: string) {
  return manager.getRepository(CoachProfileEntity).findOne({ where: { userId: userId.toLowerCase(), archivedAt: IsNull() },
    select: { userId: true }, lock: { mode: "pessimistic_read" } });
}

export type CoachProfileValues = Pick<CoachProfileEntity,
  "displayName" | "bio" | "qualifications" | "specialties" | "languages" | "isPublic">;

export async function insertCoachProfile(manager: EntityManager, userId: string, values: CoachProfileValues, updatedAt: Date) {
  await manager.createQueryBuilder().insert().into(CoachProfileEntity).values({ userId, ...values, updatedAt }).execute();
}

export async function updateCoachProfile(manager: EntityManager, userId: string, values: Partial<CoachProfileValues>, updatedAt: Date) {
  await manager.getRepository(CoachProfileEntity).update({ userId }, { ...values, updatedAt });
}

export async function changeCoachLocations(manager: EntityManager, coachUserId: string, add: readonly string[], remove: readonly string[]) {
  if (remove.length) await manager.getRepository(CoachLocationEntity).delete({ coachUserId, locationId: In([...remove]) });
  if (add.length) await manager.createQueryBuilder().insert().into(CoachLocationEntity)
    .values(add.map((locationId) => ({ coachUserId, locationId }))).execute();
}

export async function changeCoachPrograms(manager: EntityManager, coachUserId: string, add: readonly string[], remove: readonly string[]) {
  if (remove.length) await manager.getRepository(CoachProgramEntity).delete({ coachUserId, programId: In([...remove]) });
  if (add.length) await manager.createQueryBuilder().insert().into(CoachProgramEntity)
    .values(add.map((programId) => ({ coachUserId, programId }))).execute();
}

// ---- Prices ----

export async function listCoachingPrices(manager: EntityManager, filter: { locationId?: string; programId?: string; programIds?: readonly string[]; coachUserId?: string } = {}) {
  return manager.getRepository(CoachingPriceEntity).find({
    where: {
      ...(filter.locationId ? { locationId: filter.locationId.toLowerCase() } : {}),
      ...(filter.programId ? { programId: filter.programId.toLowerCase() } : {}),
      ...(filter.programIds ? { programId: In(filter.programIds.map((id) => id.toLowerCase())) } : {}),
      ...(filter.coachUserId ? { coachUserId: filter.coachUserId.toLowerCase() } : {}),
    },
    order: { programId: "ASC", durationMinutes: "ASC", locationId: "ASC", coachUserId: "ASC" },
  });
}

export type CoachingPriceKey = { programId: string; durationMinutes: number; locationId: string; coachUserId: string | null };

// One statement per scope: the partial unique index of that scope arbitrates.
export async function upsertCoachingPrice(manager: EntityManager, key: CoachingPriceKey, amountMinor: number, currency: string, updatedAt: Date) {
  const conflict = key.coachUserId
    ? "(program_id,duration_minutes,location_id,coach_user_id) WHERE coach_user_id IS NOT NULL"
    : "(program_id,duration_minutes,location_id) WHERE coach_user_id IS NULL";
  const rows: unknown = await manager.query(`INSERT INTO public.coaching_prices
    (program_id,duration_minutes,location_id,coach_user_id,amount_minor,currency,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT ${conflict} DO UPDATE SET amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,updated_at=EXCLUDED.updated_at
    RETURNING id`, [key.programId, key.durationMinutes, key.locationId, key.coachUserId, amountMinor, currency, updatedAt]);
  return returnedIds.parse(rows)[0].id;
}

export async function deleteCoachingPrice(manager: EntityManager, key: CoachingPriceKey) {
  const result = await manager.createQueryBuilder().delete().from(CoachingPriceEntity)
    .where({ programId: key.programId, durationMinutes: key.durationMinutes, locationId: key.locationId,
      coachUserId: key.coachUserId ?? IsNull() })
    .returning("id").execute();
  return returnedIds.parse(result.raw)[0]?.id ?? null;
}

// ---- Public projection ----

const publicFactsSchema = z.object({
  programs: z.array(z.object({
    id: z.uuid(), name: z.string(), description: z.string(), program_type: z.string(),
    min_participants: z.number().int().nullable(), max_participants: z.number().int().nullable(),
    court_rental_included: z.boolean(), durations: z.array(z.number().int()),
  })),
  coaches: z.array(z.object({
    user_id: z.uuid(), display_name: z.string(), bio: z.string(), qualifications: z.string(),
    specialties: z.array(z.string()), languages: z.array(z.string()),
    location_ids: z.array(z.uuid()), program_ids: z.array(z.uuid()),
  })),
  prices: z.array(z.object({
    program_id: z.uuid(), duration_minutes: z.number().int(), location_id: z.uuid(),
    coach_user_id: z.uuid().nullable(), amount_minor: z.number().int(), currency: z.string(),
  })),
});
export type PublicCoachingFacts = z.infer<typeof publicFactsSchema>;

// Explicit public projection: active programs, publicly enabled coaches whose
// account is active and still holds the coach role, and prices for those only.
// No account, contact or internal fields are selected.
export async function readPublicCoachingFacts(manager: EntityManager): Promise<PublicCoachingFacts> {
  const rows: unknown = await manager.query(`WITH programs AS (
      SELECT p.id,p.name,p.description,p.program_type,p.min_participants,p.max_participants,p.court_rental_included,
        coalesce((SELECT array_agg(d.duration_minutes ORDER BY d.duration_minutes) FROM public.coaching_program_durations d WHERE d.program_id=p.id),'{}') AS durations
      FROM public.coaching_programs p WHERE p.is_active),
    coaches AS (
      SELECT c.user_id,c.display_name,c.bio,c.qualifications,c.specialties,c.languages,
        coalesce((SELECT array_agg(l.location_id ORDER BY l.location_id) FROM public.coach_locations l WHERE l.coach_user_id=c.user_id),'{}') AS location_ids,
        coalesce((SELECT array_agg(cp.program_id ORDER BY cp.program_id) FROM public.coach_programs cp JOIN programs ap ON ap.id=cp.program_id WHERE cp.coach_user_id=c.user_id),'{}') AS program_ids
      FROM public.coach_profiles c JOIN public.users u ON u.id=c.user_id
      WHERE c.archived_at IS NULL AND c.is_public AND u.status='active'
        AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=c.user_id AND r.role_code='coach'))
    SELECT
      coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY lower(p.name),p.id) FROM programs p),'[]'::jsonb) AS programs,
      coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY lower(c.display_name),c.user_id) FROM coaches c),'[]'::jsonb) AS coaches,
      coalesce((SELECT jsonb_agg(jsonb_build_object('program_id',x.program_id,'duration_minutes',x.duration_minutes,
          'location_id',x.location_id,'coach_user_id',x.coach_user_id,'amount_minor',x.amount_minor,'currency',x.currency))
        FROM public.coaching_prices x JOIN programs p ON p.id=x.program_id
        WHERE x.coach_user_id IS NULL OR x.coach_user_id IN (SELECT user_id FROM coaches)),'[]'::jsonb) AS prices`);
  return z.array(publicFactsSchema).length(1).parse(rows)[0];
}

// Configuration cleanup deliberately excludes reservations and immutable contracts.
export async function deleteProgramPrices(manager: EntityManager, programId: string, durations?: readonly number[]) {
  if (durations && !durations.length) return;
  await manager.getRepository(CoachingPriceEntity).delete({ programId,
    ...(durations ? { durationMinutes: In([...durations]) } : {}) });
}

export async function programHasBookingHistory(manager: EntityManager, programId: string) {
  return manager.getRepository(BookingRevisionEntity).existsBy({ coachingProgramId: programId });
}

export async function deleteUnusedProgram(manager: EntityManager, programId: string) {
  await deleteProgramPrices(manager, programId);
  await manager.getRepository(CoachProgramEntity).delete({ programId });
  await manager.getRepository(CoachingProgramDurationEntity).delete({ programId });
  await manager.getRepository(CoachingProgramEntity).delete({ id: programId });
}

export async function readCoachRemovalFacts(manager: EntityManager, coachUserId: string) {
  const hasRevisions = await manager.getRepository(BookingRevisionEntity).existsBy({ coachUserId });
  const hasReservations = await manager.getRepository(CourtReservationEntity).existsBy({ coachUserId });
  const reservations = await manager.getRepository(CourtReservationEntity).createQueryBuilder("reservation")
      .innerJoin(CourtEntity, "court", "court.id=reservation.court_id")
      .innerJoin(LocationEntity, "location", "location.id=court.location_id")
      .select("reservation.status", "status").addSelect("reservation.booking_date::text", "date")
      .addSelect("reservation.ends_at_minute", "endMinute").addSelect("location.timezone", "timezone")
      .where("reservation.coach_user_id=:coachUserId AND reservation.status IN ('active','held')", { coachUserId })
      .getRawMany<unknown>();
  return { hasHistory: hasRevisions || hasReservations, reservations: z.array(z.object({
    status: z.enum(["active", "held"]), date: z.iso.date(), endMinute: z.number().int(), timezone: z.string(),
  })).parse(reservations) };
}

export async function removeCoachConfiguration(manager: EntityManager, coachUserId: string, archive: boolean, now: Date) {
  await manager.getRepository(CoachingPriceEntity).delete({ coachUserId });
  await manager.getRepository(CoachAvailabilityExceptionEntity).delete({ coachUserId });
  await manager.getRepository(CoachWeeklyAvailabilityEntity).delete({ coachUserId });
  await manager.getRepository(CoachProgramEntity).delete({ coachUserId });
  await manager.getRepository(CoachLocationEntity).delete({ coachUserId });
  if (archive) await manager.getRepository(CoachProfileEntity).update({ userId: coachUserId },
    { archivedAt: now, isPublic: false, updatedAt: now });
  else await manager.getRepository(CoachProfileEntity).delete({ userId: coachUserId });
}
