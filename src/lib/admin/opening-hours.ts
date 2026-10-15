import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { weeklyHoursMutationSchema, datedOpeningIntervalSchema, openingHoursScheduleKey, timeToMinute, openingHoursScheduleSchema, planOpeningHoursPeriod, type OpeningHoursMutationResult } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as pricing from "@/lib/db/repositories/pricing.repository";
import type { LocationOpeningHoursEntity } from "@/lib/db/entities/location-opening-hours.entity";
import { planOpeningHoursPricing, reconcileOpeningHoursPricing } from "@/lib/pricing/opening-hours-reconciliation";
import { localToday } from "@/lib/courts/local-time";

type Client = Awaited<ReturnType<typeof createClient>>;
function openingHoursDto(row: LocationOpeningHoursEntity, schedule?: { starts_on: string; ends_on: string | null }) {
  return {
    id: row.id, location_id: row.locationId, schedule_id: row.scheduleId, ...schedule && { starts_on: schedule.starts_on, ends_on: schedule.ends_on }, weekday: row.weekday,
    opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  };
}

async function readAdminHours(locationId: string) {
  try {
    const rows = await clubs.listLocationOpeningHours((await getDataSource()).manager, locationId);
    const schedules = await readSchedules(locationId);
    return z.array(datedOpeningIntervalSchema).parse(rows.map((row) => openingHoursDto(row, schedules.find((s) => s.id === row.scheduleId))));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.opening_hours_list_failed", code: failure.sqlState }, "Failed to load opening hours");
    throw new Error("Unable to load opening hours.");
  }
}

export async function listAdminLocationOpeningHours(locationId: string, supabase?: Client) {
  await requireActiveAdmin(supabase ?? await createClient());
  z.uuid().parse(locationId);
  return readAdminHours(locationId);
}

async function processAdminOpeningHours(input: unknown, supabase?: Client): Promise<OpeningHoursMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = weeklyHoursMutationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { location_id, operation } = parsed.data;
  const { schedule_id, revision } = parsed.data.operation === "create"
    ? { schedule_id: undefined, revision: undefined } : parsed.data;
  const { starts_on, ends_on, replace_ids, rows } = parsed.data.operation === "delete"
    ? { starts_on: undefined, ends_on: undefined, replace_ids: [], rows: [] } : parsed.data;
  const weekdays = [...new Set(rows.flatMap((row) => row.weekdays))];
  let failureMessage = "Unable to change opening hours.";
  let result: OpeningHoursMutationResult;
  try {
    result = await inTransaction<OpeningHoursMutationResult>(async (manager): Promise<OpeningHoursMutationResult> => {
      await clubs.lockConfigurationForWrite(manager);
      const [location] = await clubs.lockLocations(manager, [location_id]);
      // No Auth transport here: hold the same shared actor-row locks as the old
      // SQL command so suspension/role removal cannot race an accepted command.
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      if (!location) return { ok: false, reason: "not-found" };
      if (location.archivedAt) return { ok: false, reason: "archived" };
      failureMessage = "Unable to read configuration.";
      const allHours = await clubs.listLocationOpeningHours(manager, location.id);
      const schedules = await clubs.listOpeningHoursSchedules(manager, location.id);
      const existing = operation === "create" ? undefined : schedules.find((schedule) => schedule.id === schedule_id);
      if (operation !== "create" && !existing) return { ok: false, reason: "not-found" };
      if (existing && existing.revision !== revision) return { ok: false, reason: "stale" };
      const startsOn = starts_on ?? existing?.startsOn;
      if (!startsOn) throw new Error("Opening-hours start date missing.");
      const endsOn = ends_on === undefined ? existing?.endsOn ?? null : ends_on || null;
      if (endsOn && endsOn < startsOn) return { ok: false, reason: "invalid-input", fieldErrors: { ends_on: "Valid until must be on or after valid from." } };
      const now = await clubs.readOpeningHoursConfigurationTime(manager);
      const today = localToday(location.timezone, now);
      const period = planOpeningHoursPeriod(schedules.filter((s) => s.id !== existing?.id).map((s) => ({
        id: s.id, location_id: s.locationId, starts_on: s.startsOn, ends_on: s.endsOn, revision: s.revision,
      })), startsOn, endsOn, today, operation === "create");
      if (operation !== "delete" && !period.ok) return { ok: false, reason: "period-overlap" };
      const adjustment = operation === "create" && period.ok ? period.adjustment : null;
      if (parsed.data.operation === "create" && parsed.data.adjustment !== undefined
        && (parsed.data.adjustment?.id !== adjustment?.id || parsed.data.adjustment?.revision !== adjustment?.revision)) {
        return { ok: false, reason: "stale" };
      }
      const current = allHours.filter((row) => row.scheduleId === existing?.id);
      const selected = new Set(replace_ids.map((id) => id.toLowerCase()));
      if (selected.size !== replace_ids.length) {
        return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
      }
      if (current.filter((row) => selected.has(row.id)).length !== selected.size) {
        return { ok: false, reason: "not-found" };
      }
      const replacements: clubs.OpeningHoursFields[] = rows.flatMap((interval) => interval.weekdays.map((weekday) => ({
        locationId: location.id, weekday,
        opensAtMinute: timeToMinute(interval.opens_at), closesAtMinute: timeToMinute(interval.closes_at),
      })));
      const retained = current.filter((row) => !selected.has(row.id));
      const scheduleKey = (rows: readonly clubs.OpeningHoursFields[]) => openingHoursScheduleKey(rows.map((row) => ({
        weekday: row.weekday, opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute,
      })));
      const changedHours = scheduleKey(current.filter((row) => selected.has(row.id))) !== scheduleKey(replacements);
      if (operation === "update" && existing && startsOn === existing.startsOn && endsOn === existing.endsOn && !changedHours) {
        return { ok: false, reason: "unchanged" };
      }
      const candidate = [...retained, ...replacements];
      const conflictDays = [...new Set(replacements.filter((proposed) => retained.some((row) =>
        row.weekday === proposed.weekday && row.opensAtMinute < proposed.closesAtMinute
        && proposed.opensAtMinute < row.closesAtMinute)).map((row) => row.weekday))].sort((a, b) => a - b);
      if (conflictDays.length) return { ok: false, reason: "overlap", weekdays: conflictDays };

      const rules = await pricing.listLocationPricingRules(manager, location.id);
      const dated = (hours: readonly (clubs.OpeningHoursFields & { scheduleId: string })[], versions: typeof schedules) => hours.map((row) => {
        const version = versions.find((schedule) => schedule.id === row.scheduleId);
        if (!version) throw new Error("Opening-hours schedule missing.");
        return { ...row, startsOn: version.startsOn, endsOn: version.endsOn };
      });
      const id = existing?.id ?? "new";
      const candidateSchedules = schedules.filter((schedule) => schedule.id !== id)
        .map((schedule) => schedule.id === adjustment?.id ? { ...schedule, endsOn: adjustment.ends_on } : schedule);
      if (operation !== "delete") candidateSchedules.push({ id, locationId: location.id, startsOn, endsOn, revision: 1 });
      const candidateHours = [...allHours.filter((row) => row.scheduleId !== id),
        ...(operation === "delete" ? [] : candidate.map((row) => ({ ...row, scheduleId: id })))];
      const courts = await clubs.listActiveLocationCourts(manager, location.id);
      const reconciliation = reconcileOpeningHoursPricing(rules, dated(allHours, schedules), dated(candidateHours, candidateSchedules), today, candidateSchedules,
        courts.map((court) => ({ courtId: court.id, courtState: court.environment })));
      const pricingPlan = planOpeningHoursPricing(rules, reconciliation);
      failureMessage = "Unable to change opening hours.";
      let savedId = existing?.id;
      if (operation === "delete") await clubs.deleteOpeningHoursSchedule(manager, location.id, id);
      else {
        if (adjustment) await clubs.saveOpeningHoursSchedule(manager, {
          id: adjustment.id, locationId: location.id, startsOn: adjustment.starts_on,
          endsOn: adjustment.ends_on, revision: adjustment.revision,
        });
        const fields = { locationId: location.id, startsOn, endsOn };
        const scheduleId = await clubs.saveOpeningHoursSchedule(manager, existing
          ? { ...fields, id: existing.id, revision: existing.revision } : fields);
        savedId = scheduleId;
        if (changedHours) {
          await clubs.deleteSelectedOpeningHours(manager, location.id, [...selected]);
          await clubs.insertOpeningHours(manager, replacements.map((row) => ({ ...row, scheduleId })));
        }
      }
      await pricing.applyOpeningHoursPricing(manager, location.id, pricingPlan, now);
      failureMessage = "Unable to refresh opening hours.";
      const refreshed = await clubs.listLocationOpeningHours(manager, location.id);
      const refreshedSchedules = await readSchedules(location.id, manager);
      const hours = z.array(datedOpeningIntervalSchema).parse(refreshed.map((row) => openingHoursDto(row, refreshedSchedules.find((s) => s.id === row.scheduleId))));
      failureMessage = "Unable to change opening hours.";
      return { ok: true, intervals: hours, schedules: refreshedSchedules, scheduleId: savedId, pricingAdjusted: reconciliation.changed.length > 0 || reconciliation.additions.length > 0,
        missingPricing: reconciliation.missingPricing };
    });
  } catch (error) {
    // inTransaction has rolled back.
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01") return failure.constraint === "opening_hours_schedules_no_overlap"
      ? { ok: false, reason: "period-overlap" } : { ok: false, reason: "overlap", weekdays };
    if (failure.sqlState === "23503") return { ok: false, reason: "not-found" };
    if (failure.sqlState === "23514") return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
    logger.error({ event: failureMessage === "Unable to refresh opening hours." ? "admin.opening_hours_refresh_failed" : "admin.opening_hours_mutation_failed",
      actorId: actor.userId, locationId: location_id, code: failure.sqlState }, "Failed to change opening hours");
    throw new Error(failureMessage);
  }
  if (result.ok) logger.info({ event: "admin.opening_hours_changed", actorId: actor.userId, locationId: location_id, weekdayCount: weekdays.length }, "Opening hours changed");
  return result;
}

export async function mutateAdminOpeningHours(input: unknown, supabase?: Client) {
  return processAdminOpeningHours(input, supabase);
}

async function readSchedules(locationId: string, manager?: import("typeorm").EntityManager) {
  const rows = await clubs.listOpeningHoursSchedules(manager ?? (await getDataSource()).manager, locationId);
  return z.array(openingHoursScheduleSchema).parse(rows.map((row) => ({
    id: row.id, location_id: row.locationId, starts_on: row.startsOn, ends_on: row.endsOn, revision: row.revision,
  })));
}
export async function listAdminOpeningHoursSchedules(locationId: string, supabase?: Client) {
  await requireActiveAdmin(supabase ?? await createClient());
  z.uuid().parse(locationId);
  return readSchedules(locationId);
}
