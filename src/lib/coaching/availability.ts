import "server-only";

import type { EntityManager } from "typeorm";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { localToday } from "@/lib/courts/local-time";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findAccountById, lockActiveAdminAccount, lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import * as availability from "@/lib/db/repositories/coach-availability.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as coaching from "@/lib/db/repositories/coaching.repository";
import { inReadSnapshot, inTransaction, readIndependently } from "@/lib/db/transaction";
import type { LocationEntity } from "@/lib/db/entities/location.entity";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { coachIneligibility, type AdminCoach } from "./admin";
import { requireActiveCoach } from "./authorization";
import {
  adminAvailabilityChangeSchema, availabilityChangeSchema, availabilityExceptionHorizonDays, availabilityFieldErrors, rangesOverlap,
  type AvailabilityChange, type AvailabilityMutationResult, type CoachAvailabilityExceptionKind,
} from "./availability-validation";

type Client = Awaited<ReturnType<typeof createClient>>;

export type CoachAvailabilityLocation = { id: string; name: string; timezone: string; is_active: boolean; archived: boolean };
export type CoachWeeklyInterval = { id: string; location_id: string; weekday: number; start_minute: number; end_minute: number };
export type CoachAvailabilityExceptionRow = {
  id: string; date: string; kind: CoachAvailabilityExceptionKind; location_id: string | null;
  start_minute: number | null; end_minute: number | null; note: string;
};
export type CoachAvailabilityView = {
  coach: { user_id: string; display_name: string; ineligibility: AdminCoach["ineligibility"] };
  // The coach's assigned locations; only current (non-archived) ones accept new availability.
  locations: CoachAvailabilityLocation[];
  weekly: CoachWeeklyInterval[];
  exceptions: CoachAvailabilityExceptionRow[];
  // Earliest local date across the coach's locations, and the planning horizon.
  today: string; horizon: string;
};
export type AdminCoachAvailability = {
  coaches: { user_id: string; display_name: string; ineligibility: AdminCoach["ineligibility"] }[];
  selected: CoachAvailabilityView | null;
};

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Coach-wide dates (whole-day absences) start at the earliest local date across locations.
function earliestToday(locations: readonly Pick<LocationEntity, "timezone">[], now: Date) {
  const dates = (locations.length ? locations.map((location) => location.timezone) : ["UTC"]).map((timezone) => localToday(timezone, now));
  return dates.sort()[0];
}

async function readView(manager: EntityManager, coachUserId: string, now: Date): Promise<CoachAvailabilityView | null> {
  const profile = await coaching.findCoachProfile(manager, coachUserId);
  if (!profile) return null;
  const [account, locations, weekly, exceptions] = await readIndependently(manager, [
    () => findAccountById(manager, profile.userId), () => availability.listCoachAvailabilityLocations(manager, profile.locationIds),
    () => availability.listCoachWeeklyAvailability(manager, profile.userId),
    () => availability.listCoachAvailabilityExceptions(manager, profile.userId),
  ]);
  const today = earliestToday(locations, now);
  return {
    coach: {
      user_id: profile.userId, display_name: profile.displayName,
      ineligibility: coachIneligibility(account && { status: account.user.status, roles: account.roleCodes }),
    },
    locations: locations.map((location) => ({ id: location.id, name: location.name, timezone: location.timezone,
      is_active: location.isActive, archived: location.archivedAt !== null })),
    weekly: weekly.map((row) => ({ id: row.id, location_id: row.locationId, weekday: row.weekday, start_minute: row.startMinute, end_minute: row.endMinute })),
    exceptions: exceptions.map((row) => ({ id: row.id, date: row.exceptionDate, kind: row.kind, location_id: row.locationId,
      start_minute: row.startMinute, end_minute: row.endMinute, note: row.note })),
    today, horizon: addDays(today, availabilityExceptionHorizonDays),
  };
}

function loadFailed(error: unknown): never {
  const failure = normalizeDatabaseError(error);
  logger.error({ event: "coaching.availability_load_failed", kind: failure.kind, code: failure.sqlState }, "Failed to load coach availability");
  throw new Error("Unable to load coach availability.");
}

// The signed-in coach's own schedule; null until an Admin creates their coaching profile.
export async function loadOwnCoachAvailability(supabase?: Client) {
  const account = await requireActiveCoach(supabase ?? await createClient());
  try {
    return await inReadSnapshot((manager) => readView(manager, account.userId, new Date()));
  } catch (error) {
    return loadFailed(error);
  }
}

export async function loadAdminCoachAvailability(coachUserId: string | undefined, supabase?: Client): Promise<AdminCoachAvailability> {
  await requireActiveAdmin(supabase ?? await createClient());
  try {
    return await inReadSnapshot(async (manager) => {
      const coaches = (await coaching.listCoachProfiles(manager)).map((coach) => ({
        user_id: coach.user_id, display_name: coach.display_name,
        ineligibility: coachIneligibility({ status: coach.account_status, roles: coach.has_coach_role ? ["coach"] : [] }),
      }));
      const selected = coaches.find((coach) => coach.user_id === coachUserId?.toLowerCase()) ?? coaches[0];
      return { coaches, selected: selected ? await readView(manager, selected.user_id, new Date()) : null };
    });
  } catch (error) {
    return loadFailed(error);
  }
}

type Actor = { userId: string; admin: boolean };

async function applyChange(manager: EntityManager, actor: Actor, coachUserId: string, change: AvailabilityChange): Promise<AvailabilityMutationResult> {
  // Configuration fence → profile → ordered locations → actor → coach account, as coach
  // profile saves do, so assignment changes and availability writes serialize per coach.
  await clubs.lockConfigurationForRead(manager);
  const profile = await coaching.lockCoachProfile(manager, coachUserId, "pessimistic_write");
  if (!profile) return { ok: false, reason: actor.admin ? "not-found" : "not-eligible" };
  const target = "fields" in change && change.fields.location_id ? change.fields.location_id.toLowerCase() : null;
  const locations = await clubs.lockLocationsForRead(manager, [...profile.locationIds, ...target ? [target] : []]);
  if (actor.admin && !await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
  const ineligible = coachIneligibility(await lockReservationActorFacts(manager, profile.userId));
  // Admins may still clear availability of a suspended or former coach.
  const removal = change.operation === "remove-weekly" || change.operation === "remove-exception";
  if (ineligible && !(actor.admin && removal)) return { ok: false, reason: "not-eligible" };
  const coach = profile.userId;
  const now = new Date();
  const location = target === null ? null
    : locations.find((item) => item.id === target && item.archivedAt === null && profile.locationIds.includes(item.id));
  if (target !== null && !location) return { ok: false, reason: "invalid-location" };

  switch (change.operation) {
    case "save-weekly": {
      const { fields } = change;
      const existing = await availability.listCoachWeeklyAvailability(manager, coach);
      if (change.id && !existing.some((row) => row.id === change.id?.toLowerCase())) return { ok: false, reason: "not-found" };
      // One coach works one interval at a time, whichever location it is at.
      if (existing.some((row) => row.id !== change.id?.toLowerCase() && row.weekday === fields.weekday
        && rangesOverlap({ start: row.startMinute, end: row.endMinute }, { start: fields.start_minute, end: fields.end_minute }))) {
        return { ok: false, reason: "overlap" };
      }
      const values = { locationId: target as string, weekday: fields.weekday, startMinute: fields.start_minute, endMinute: fields.end_minute };
      if (!change.id) return { ok: true, id: await availability.insertCoachWeeklyAvailability(manager, coach, values, now) };
      await availability.updateCoachWeeklyAvailability(manager, coach, change.id.toLowerCase(), values, now);
      return { ok: true, id: change.id.toLowerCase() };
    }
    case "add-weekly": {
      const { fields } = change;
      const weekdays = [...fields.weekdays].sort((a, b) => a - b);
      const range = { start: fields.start_minute, end: fields.end_minute };
      const existing = await availability.listCoachWeeklyAvailability(manager, coach);
      // Every selected day is checked before anything is written: one conflict saves nothing.
      const conflicts = weekdays.filter((weekday) => existing.some((row) => row.weekday === weekday
        && rangesOverlap({ start: row.startMinute, end: row.endMinute }, range)));
      if (conflicts.length) return { ok: false, reason: "overlap", weekdays: conflicts };
      const ids: string[] = [];
      for (const weekday of weekdays) {
        ids.push(await availability.insertCoachWeeklyAvailability(manager, coach,
          { locationId: target as string, weekday, startMinute: range.start, endMinute: range.end }, now));
      }
      return { ok: true, id: ids[0], ids };
    }
    case "remove-weekly":
      return await availability.deleteCoachWeeklyAvailability(manager, coach, change.id.toLowerCase())
        ? { ok: true, id: change.id.toLowerCase() } : { ok: false, reason: "not-found" };
    case "save-exception": {
      const { fields } = change;
      // Additional hours use their location's date; absences the earliest local date.
      const today = location ? localToday(location.timezone, now) : earliestToday(locations, now);
      if (fields.date < today || fields.date > addDays(today, availabilityExceptionHorizonDays)) return { ok: false, reason: "out-of-range" };
      const sameDate = await availability.listCoachAvailabilityExceptions(manager, coach, { date: fields.date });
      if (change.id) {
        const [current] = await availability.listCoachAvailabilityExceptions(manager, coach, { id: change.id });
        if (!current) return { ok: false, reason: "not-found" };
        if (current.exceptionDate < today) return { ok: false, reason: "out-of-range" };
      }
      const range = { start: fields.start_minute ?? 0, end: fields.end_minute ?? 1440 };
      if (sameDate.some((row) => row.id !== change.id?.toLowerCase()
        && rangesOverlap({ start: row.startMinute ?? 0, end: row.endMinute ?? 1440 }, range))) return { ok: false, reason: "overlap" };
      const values = { exceptionDate: fields.date, kind: fields.kind, locationId: target, startMinute: fields.start_minute,
        endMinute: fields.end_minute, note: fields.note };
      if (!change.id) return { ok: true, id: await availability.insertCoachAvailabilityException(manager, coach, values, now) };
      await availability.updateCoachAvailabilityException(manager, coach, change.id.toLowerCase(), values, now);
      return { ok: true, id: change.id.toLowerCase() };
    }
    case "remove-exception":
      return await availability.deleteCoachAvailabilityException(manager, coach, change.id.toLowerCase())
        ? { ok: true, id: change.id.toLowerCase() } : { ok: false, reason: "not-found" };
  }
}

async function mutate(actor: Actor, coachUserId: string, change: AvailabilityChange): Promise<AvailabilityMutationResult> {
  const event = `coaching.availability_${change.operation.replace("-", "_")}`;
  let result: AvailabilityMutationResult;
  try {
    result = await inTransaction((manager) => applyChange(manager, actor, coachUserId, change));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    // Exclusions and composite FKs remain authoritative behind the TypeScript checks.
    if (failure.sqlState === "23P01") return { ok: false, reason: "overlap" };
    if (failure.sqlState === "23503") return { ok: false, reason: failure.constraint?.endsWith("_coach_location_fkey") ? "invalid-location" : "not-found" };
    logger.error({ event: `${event}_failed`, actorId: actor.userId, kind: failure.kind, code: failure.sqlState }, "Failed to save coach availability");
    throw new Error("Unable to save coach availability.");
  }
  if (result.ok) logger.info({ event, actorId: actor.userId, coachUserId, id: result.id, ...result.ids && { ids: result.ids } }, "Coach availability saved");
  return result;
}

// Coaches change only their own schedule: the coach is the verified session account.
export async function changeOwnCoachAvailability(input: unknown, supabase?: Client): Promise<AvailabilityMutationResult> {
  const account = await requireActiveCoach(supabase ?? await createClient());
  const parsed = availabilityChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: availabilityFieldErrors(parsed.error.issues) };
  return mutate({ userId: account.userId, admin: false }, account.userId, parsed.data);
}

export async function changeCoachAvailability(input: unknown, supabase?: Client): Promise<AvailabilityMutationResult> {
  const account = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = adminAvailabilityChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: availabilityFieldErrors(parsed.error.issues) };
  return mutate({ userId: account.userId, admin: true }, parsed.data.coach_user_id.toLowerCase(), parsed.data.change);
}
