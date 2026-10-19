import "server-only";

import { In, type EntityManager } from "typeorm";
import { z } from "zod";

import { mondayWeekday } from "@/lib/pricing/resolution";

import { readIndependently } from "../transaction";

import { CoachAvailabilityExceptionEntity } from "../entities/coach-availability-exception.entity";
import { CoachWeeklyAvailabilityEntity } from "../entities/coach-weekly-availability.entity";
import { LocationEntity } from "../entities/location.entity";

const returnedIds = z.array(z.object({ id: z.uuid() }));

export async function listCoachWeeklyAvailability(manager: EntityManager, coachUserId: string) {
  return manager.getRepository(CoachWeeklyAvailabilityEntity).find({
    where: { coachUserId: coachUserId.toLowerCase() },
    order: { weekday: "ASC", startMinute: "ASC", id: "ASC" },
  });
}

export async function listCoachAvailabilityExceptions(manager: EntityManager, coachUserId: string, filter: { id?: string; date?: string } = {}) {
  return manager.getRepository(CoachAvailabilityExceptionEntity).find({
    where: {
      coachUserId: coachUserId.toLowerCase(),
      ...(filter.id ? { id: filter.id.toLowerCase() } : {}),
      ...(filter.date ? { exceptionDate: filter.date } : {}),
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
      where: { coachUserId: coach, weekday: mondayWeekday(date) }, order: { startMinute: "ASC", id: "ASC" },
    }),
    () => manager.getRepository(CoachAvailabilityExceptionEntity).find({
      select: { exceptionDate: true, kind: true, locationId: true, startMinute: true, endMinute: true },
      where: { coachUserId: coach, exceptionDate: date }, order: { startMinute: { direction: "ASC", nulls: "FIRST" }, id: "ASC" },
    }),
  ]);
  return {
    weekly: weekly.map((row) => ({ location_id: row.locationId, weekday: row.weekday, start_minute: row.startMinute, end_minute: row.endMinute })),
    exceptions: exceptions.map((row) => ({ date: row.exceptionDate, kind: row.kind, location_id: row.locationId,
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

export type WeeklyAvailabilityValues = Pick<CoachWeeklyAvailabilityEntity, "locationId" | "weekday" | "startMinute" | "endMinute">;

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

export type AvailabilityExceptionValues = Pick<CoachAvailabilityExceptionEntity,
  "exceptionDate" | "kind" | "locationId" | "startMinute" | "endMinute" | "note">;

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
