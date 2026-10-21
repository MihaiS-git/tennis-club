import "server-only";

import { IsNull, LessThanOrEqual, MoreThanOrEqual, In, type EntityManager } from "typeorm";
import { z } from "zod";

import { mondayWeekday } from "@/lib/pricing/resolution";

import { readIndependently } from "../transaction";

import { CoachAvailabilityExceptionEntity } from "../entities/coach-availability-exception.entity";
import { CoachWeeklyAvailabilityEntity } from "../entities/coach-weekly-availability.entity";
import { LocationEntity } from "../entities/location.entity";
import { LocationOpeningHoursEntity } from "../entities/location-opening-hours.entity";
import { OpeningHoursScheduleEntity } from "../entities/opening-hours-schedule.entity";

const returnedIds = z.array(z.object({ id: z.uuid() }));

export async function listCoachWeeklyAvailability(manager: EntityManager, coachUserId: string) {
  return manager.getRepository(CoachWeeklyAvailabilityEntity).find({
    where: { coachUserId: coachUserId.toLowerCase() },
    order: { weekday: "ASC", startMinute: "ASC", validFrom: "ASC", id: "ASC" },
  });
}

// Every coach's working hours at one location, for opening-hours reconciliation under
// the exclusive configuration fence, which excludes every availability write.
export async function listLocationWeeklyAvailability(manager: EntityManager, locationId: string) {
  return manager.getRepository(CoachWeeklyAvailabilityEntity).find({
    where: { locationId: locationId.toLowerCase() },
    order: { coachUserId: "ASC", weekday: "ASC", startMinute: "ASC", validFrom: "ASC", id: "ASC" },
  });
}

export async function listCoachAvailabilityExceptions(manager: EntityManager, coachUserId: string, filter: { id?: string; date?: string } = {}) {
  return manager.getRepository(CoachAvailabilityExceptionEntity).find({
    where: {
      coachUserId: coachUserId.toLowerCase(),
      ...(filter.id ? { id: filter.id.toLowerCase() } : {}),
      ...(filter.date ? { exceptionDate: LessThanOrEqual(filter.date), untilDate: MoreThanOrEqual(filter.date) } : {}),
    },
    order: { exceptionDate: "ASC", startMinute: { direction: "ASC", nulls: "FIRST" }, id: "ASC" },
  });
}

// One coach's schedule facts for one local date, shaped for resolveCoachAvailability.
// Private notes are not selected. Unlocked: a booking transaction rereads it under its locks.
export async function listCoachDayAvailability(manager: EntityManager, coachUserId: string, date: string) {
  const coach = coachUserId.toLowerCase();
  const [weekly, exceptions] = await readIndependently(manager, [
    () => manager.getRepository(CoachWeeklyAvailabilityEntity).find({
      select: { locationId: true, weekday: true, startMinute: true, endMinute: true },
      // Only the working hours valid on this date (an open end is unbounded).
      where: [IsNull(), MoreThanOrEqual(date)].map((validUntil) => ({ coachUserId: coach, weekday: mondayWeekday(date), validFrom: LessThanOrEqual(date), validUntil })),
      order: { startMinute: "ASC", id: "ASC" },
    }),
    () => manager.getRepository(CoachAvailabilityExceptionEntity).find({
      select: { exceptionDate: true, untilDate: true, kind: true, locationId: true, startMinute: true, endMinute: true },
      where: { coachUserId: coach, exceptionDate: LessThanOrEqual(date), untilDate: MoreThanOrEqual(date) }, order: { startMinute: { direction: "ASC", nulls: "FIRST" }, id: "ASC" },
    }),
  ]);
  return {
    weekly: weekly.map((row) => ({ location_id: row.locationId, weekday: row.weekday, start_minute: row.startMinute, end_minute: row.endMinute })),
    exceptions: exceptions.map((row) => ({ date: row.exceptionDate, until_date: row.untilDate, kind: row.kind, location_id: row.locationId,
      start_minute: row.startMinute, end_minute: row.endMinute })),
  };
}

// Unlocked read of a coach's assigned locations, for display and resolution.
export async function listCoachAvailabilityLocations(manager: EntityManager, locationIds: readonly string[]) {
  if (!locationIds.length) return [];
  return manager.getRepository(LocationEntity).find({
    where: { id: In([...new Set(locationIds.map((id) => id.toLowerCase()))]) },
    order: { displayOrder: "ASC", name: "ASC", id: "ASC" },
  });
}

// Whether any weekly interval or exception still references these assignments.
export async function listLocationsWithCoachAvailability(manager: EntityManager, coachUserId: string, locationIds: readonly string[]) {
  if (!locationIds.length) return [];
  const rows: unknown = await manager.query(`SELECT location_id FROM public.coach_weekly_availability WHERE coach_user_id=$1 AND location_id=ANY($2::uuid[])
    UNION SELECT location_id FROM public.coach_availability_exceptions WHERE coach_user_id=$1 AND location_id=ANY($2::uuid[])
    ORDER BY location_id`, [coachUserId, [...locationIds]]);
  return z.array(z.object({ location_id: z.uuid() })).parse(rows).map((row) => row.location_id);
}

export type WeeklyAvailabilityValues = Pick<CoachWeeklyAvailabilityEntity, "locationId" | "weekday" | "startMinute" | "endMinute" | "validFrom" | "validUntil">;

export async function insertCoachWeeklyAvailability(manager: EntityManager, coachUserId: string, values: WeeklyAvailabilityValues, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(CoachWeeklyAvailabilityEntity)
    .values({ coachUserId, ...values, updatedAt }).returning("id").execute();
  return returnedIds.parse(result.raw)[0].id;
}

export async function updateCoachWeeklyAvailability(manager: EntityManager, coachUserId: string, id: string, values: WeeklyAvailabilityValues, updatedAt: Date) {
  const result = await manager.getRepository(CoachWeeklyAvailabilityEntity).update({ id, coachUserId }, { ...values, updatedAt });
  return result.affected === 1;
}

export async function deleteCoachWeeklyAvailability(manager: EntityManager, coachUserId: string, id: string) {
  const result = await manager.getRepository(CoachWeeklyAvailabilityEntity).delete({ id, coachUserId });
  return result.affected === 1;
}

export type WorkingHoursReplacement = { row: Pick<CoachWeeklyAvailabilityEntity, "id" | "coachUserId" | "locationId">; replacements: Omit<WeeklyAvailabilityValues, "locationId">[] };

// Replaces reconciled rows: the first replacement keeps the row's identity, others are
// inserted and an emptied row is deleted. Replacements never exceed the replaced row.
export async function replaceCoachWeeklyAvailability(manager: EntityManager, changes: readonly WorkingHoursReplacement[], updatedAt: Date) {
  for (const { row, replacements } of changes) {
    const [first, ...rest] = replacements;
    if (!first) {
      if (!await deleteCoachWeeklyAvailability(manager, row.coachUserId, row.id)) throw new Error("Working hours changed during reconciliation.");
      continue;
    }
    if (!await updateCoachWeeklyAvailability(manager, row.coachUserId, row.id, { ...first, locationId: row.locationId }, updatedAt)) {
      throw new Error("Working hours changed during reconciliation.");
    }
    for (const values of rest) await insertCoachWeeklyAvailability(manager, row.coachUserId, { ...values, locationId: row.locationId }, updatedAt);
  }
}

export type AvailabilityExceptionValues = Pick<CoachAvailabilityExceptionEntity,
  "exceptionDate" | "untilDate" | "kind" | "locationId" | "startMinute" | "endMinute" | "note">;

export async function insertCoachAvailabilityException(manager: EntityManager, coachUserId: string, values: AvailabilityExceptionValues, updatedAt: Date) {
  const result = await manager.createQueryBuilder().insert().into(CoachAvailabilityExceptionEntity)
    .values({ coachUserId, ...values, updatedAt }).returning("id").execute();
  return returnedIds.parse(result.raw)[0].id;
}

export async function updateCoachAvailabilityException(manager: EntityManager, coachUserId: string, id: string, values: AvailabilityExceptionValues, updatedAt: Date) {
  const result = await manager.getRepository(CoachAvailabilityExceptionEntity).update({ id, coachUserId }, { ...values, updatedAt });
  return result.affected === 1;
}

export async function deleteCoachAvailabilityException(manager: EntityManager, coachUserId: string, id: string) {
  const result = await manager.getRepository(CoachAvailabilityExceptionEntity).delete({ id, coachUserId });
  return result.affected === 1;
}

// Called under the coach profile write fence, shared by booking commands. Dates
// are compared as local calendar dates, independently of each location's timezone.
export async function hasCoachExceptionBookingConflict(manager: EntityManager, coachUserId: string,
  from: string, until: string, start: number, end: number, extraLocationId: string | null) {
  const rows: unknown = await manager.query(`SELECT EXISTS (
    SELECT 1 FROM public.court_reservations r JOIN public.courts c ON c.id=r.court_id
    WHERE r.coach_user_id=$1 AND r.booking_date BETWEEN $2::date AND $3::date
      AND (r.status='active' OR (r.status='held' AND r.hold_expires_at > clock_timestamp()))
      AND ($6::uuid IS NULL OR c.location_id <> $6::uuid)
      AND r.starts_at_minute < $5 AND r.ends_at_minute > $4
  ) AS conflict`, [coachUserId, from, until, start, end, extraLocationId]);
  return z.array(z.object({ conflict: z.boolean() })).parse(rows)[0].conflict;
}

// Dated opening-hours schedules of the coach's locations, for read-only display beside
// working hours. Past schedules are omitted; the caller resolves each location's local date.
export async function listCoachLocationOpeningHours(manager: EntityManager, locationIds: readonly string[], earliestDate: string) {
  const ids = [...new Set(locationIds.map((id) => id.toLowerCase()))];
  if (!ids.length) return { schedules: [], hours: [] };
  const [schedules, hours] = await readIndependently(manager, [
    () => manager.getRepository(OpeningHoursScheduleEntity).createQueryBuilder("s")
      .where({ locationId: In(ids) }).andWhere("(s.ends_on IS NULL OR s.ends_on >= :earliestDate)", { earliestDate })
      .orderBy("s.location_id").addOrderBy("s.starts_on").addOrderBy("s.id").getMany(),
    () => manager.getRepository(LocationOpeningHoursEntity).find({
      where: { locationId: In(ids) },
      select: { id: true, locationId: true, scheduleId: true, weekday: true, opensAtMinute: true, closesAtMinute: true },
      order: { weekday: "ASC", opensAtMinute: "ASC", id: "ASC" },
    }),
  ]);
  return { schedules, hours };
}

// Batched selector facts, without private notes or occupancy. Exceptions at other
// locations must remain present: extra hours there override regular local hours.
export async function listCoachingSelectorAvailability(manager: EntityManager, coachIds: readonly string[], locationId: string, today: string) {
  if (!coachIds.length) return { weekly: [], exceptions: [], schedules: [], hours: [] };
  const [weekly, exceptions, opening] = await readIndependently(manager, [
    () => manager.getRepository(CoachWeeklyAvailabilityEntity).find({
      select: { coachUserId: true, locationId: true, weekday: true, startMinute: true, endMinute: true, validFrom: true, validUntil: true },
      where: [IsNull(), MoreThanOrEqual(today)].map(validUntil => ({ coachUserId: In([...coachIds]), locationId, validUntil })),
    }),
    () => manager.getRepository(CoachAvailabilityExceptionEntity).find({
      select: { coachUserId: true, exceptionDate: true, untilDate: true, kind: true, locationId: true, startMinute: true, endMinute: true },
      where: { coachUserId: In([...coachIds]), untilDate: MoreThanOrEqual(today) },
    }),
    () => listCoachLocationOpeningHours(manager, [locationId], today),
  ]);
  return { weekly, exceptions, ...opening };
}
