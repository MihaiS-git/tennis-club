import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { weeklyHoursMutationSchema, openingIntervalSchema, openingHoursScheduleKey, timeToMinute, minuteToTime, weekdays, type OpeningHoursMutationResult } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as pricing from "@/lib/db/repositories/pricing.repository";
import type { LocationOpeningHoursEntity } from "@/lib/db/entities/location-opening-hours.entity";
import { fitsOpeningHours, pricingHasFutureOccurrence } from "@/lib/pricing/resolution";
import { localToday } from "@/lib/courts/local-time";

type Client = Awaited<ReturnType<typeof createClient>>;
const pricingConflictSchema = z.array(z.object({
  weekday: z.number().int().min(0).max(6),
  starts_at_minute: z.number().int().min(0).max(1439),
  ends_at_minute: z.number().int().min(1).max(1440),
})).min(1).max(4);

function pricingConflictMessage(details: string | undefined): string {
  const fallback = "These opening hours conflict with existing pricing. Update or remove the conflicting pricing rule before changing the opening hours.";
  if (!details) return fallback;
  try {
    const parsed = pricingConflictSchema.safeParse(JSON.parse(details));
    if (!parsed.success) return fallback;
    const examples = parsed.data.slice(0, 3).map((item) =>
      `${weekdays[item.weekday]} (${minuteToTime(item.starts_at_minute)}–${minuteToTime(item.ends_at_minute)})`);
    return `These opening hours conflict with existing pricing on ${examples.join(", ")}${parsed.data.length > 3 ? ", and other rules" : ""}. Update or remove the conflicting pricing rule before changing the opening hours.`;
  } catch { return fallback; }
}

function openingHoursDto(row: LocationOpeningHoursEntity) {
  return {
    id: row.id, location_id: row.locationId, weekday: row.weekday,
    opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  };
}

async function readAdminHours(locationId?: string) {
  try {
    const rows = await clubs.listLocationOpeningHours((await getDataSource()).manager, locationId);
    return z.array(openingIntervalSchema).parse(rows.map(openingHoursDto));
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

async function processAdminOpeningHours(input: unknown, supabase?: Client, checkRemoval = false): Promise<OpeningHoursMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = weeklyHoursMutationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { location_id, weekdays, replace_ids, intervals } = parsed.data;
  if (checkRemoval && (intervals.length !== 0 || replace_ids.length === 0)) {
    return { ok: false, reason: "invalid-input", fieldErrors: { form: "Select opening hours to remove." } };
  }
  let failureMessage = "Unable to change opening hours.";
  let result: OpeningHoursMutationResult;
  try {
    result = await inTransaction<OpeningHoursMutationResult>(async (manager) => {
      await clubs.lockConfigurationForWrite(manager);
      const [location] = await clubs.lockLocations(manager, [location_id]);
      // No Auth transport here: hold the same shared actor-row locks as the old
      // SQL command so suspension/role removal cannot race an accepted command.
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      if (!location) return { ok: false, reason: "not-found" };
      if (location.archivedAt) return { ok: false, reason: "archived" };
      failureMessage = "Unable to read configuration.";
      const current = await clubs.listLocationOpeningHours(manager, location.id);
      const selected = new Set(replace_ids.map((id) => id.toLowerCase()));
      if (selected.size !== replace_ids.length) {
        return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
      }
      if (current.filter((row) => selected.has(row.id)).length !== selected.size) {
        return { ok: false, reason: "not-found" };
      }
      const replacements: clubs.OpeningHoursFields[] = weekdays.flatMap((weekday) => intervals.map((interval) => ({
        locationId: location.id, weekday,
        opensAtMinute: timeToMinute(interval.opens_at), closesAtMinute: timeToMinute(interval.closes_at),
      })));
      const retained = current.filter((row) => !selected.has(row.id));
      const scheduleKey = (rows: readonly clubs.OpeningHoursFields[]) => openingHoursScheduleKey(rows.map((row) => ({
        weekday: row.weekday, opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute,
      })));
      if (scheduleKey(current.filter((row) => selected.has(row.id))) === scheduleKey(replacements)) {
        return { ok: false, reason: "unchanged" };
      }
      const candidate = [...retained, ...replacements];
      const conflictDays = [...new Set(replacements.filter((proposed) => retained.some((row) =>
        row.weekday === proposed.weekday && row.opensAtMinute < proposed.closesAtMinute
        && proposed.opensAtMinute < row.closesAtMinute)).map((row) => row.weekday))].sort((a, b) => a - b);
      if (conflictDays.length) return { ok: false, reason: "overlap", weekdays: conflictDays };

      const rules = await pricing.listLocationHoursCompatibilityPricing(manager, location.id);
      const now = await clubs.readOpeningHoursConfigurationTime(manager);
      const today = localToday(location.timezone, now);
      const applicable = rules.filter((rule) => pricingHasFutureOccurrence({
        weekday: rule.weekday, starts_on: rule.startsOn, ends_on: rule.endsOn,
      }, today));
      const schedule = candidate.map((row) => ({ location_id: row.locationId, weekday: row.weekday,
        opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute }));
      const conflicts = applicable.filter((rule) => !fitsOpeningHours(schedule, {
        location_id: location.id, weekday: rule.weekday,
        starts_at_minute: rule.startsAtMinute, ends_at_minute: rule.endsAtMinute,
      }));
      if (conflicts.length) {
        // Match the safeguard's ordered, distinct examples and four-item limit.
        const times = conflicts.map((rule) => ({ weekday: rule.weekday, starts_at_minute: rule.startsAtMinute, ends_at_minute: rule.endsAtMinute }));
        const examples = [...new Map(times.map((item) => [JSON.stringify(item), item])).values()].slice(0, 4);
        return { ok: false, reason: "pricing-conflict", message: pricingConflictMessage(JSON.stringify(examples)),
          conflicts: conflicts.map((rule) => ({ id: rule.id, rule_set_id: rule.ruleSetId, court_name: rule.court.name,
            court_state: rule.courtState, weekday: rule.weekday, starts_at_minute: rule.startsAtMinute,
            ends_at_minute: rule.endsAtMinute, starts_on: rule.startsOn, ends_on: rule.endsOn })) };
      }
      // A preview uses exactly the mutation's locked dependency checks, without
      // deleting rows. Confirmation always runs the same checks again.
      if (checkRemoval) return { ok: true, intervals: current.map(openingHoursDto) };
      failureMessage = "Unable to change opening hours.";
      await clubs.deleteSelectedOpeningHours(manager, location.id, [...selected]);
      await clubs.insertOpeningHours(manager, replacements);
      failureMessage = "Unable to refresh opening hours.";
      const refreshed = await clubs.listLocationOpeningHours(manager, location.id);
      const hours = z.array(openingIntervalSchema).parse(refreshed.map(openingHoursDto));
      failureMessage = "Unable to change opening hours.";
      return { ok: true, intervals: hours };
    });
  } catch (error) {
    // inTransaction has rolled back.
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01") return { ok: false, reason: "overlap", weekdays };
    if (failure.sqlState === "23503") return { ok: false, reason: "not-found" };
    if (failure.sqlState === "23514") return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
    logger.error({ event: failureMessage === "Unable to refresh opening hours." ? "admin.opening_hours_refresh_failed" : "admin.opening_hours_mutation_failed",
      actorId: actor.userId, locationId: location_id, code: failure.sqlState }, "Failed to change opening hours");
    throw new Error(failureMessage);
  }
  if (result.ok && !checkRemoval) logger.info({ event: "admin.opening_hours_changed", actorId: actor.userId, locationId: location_id, weekdayCount: weekdays.length }, "Opening hours changed");
  return result;
}

export async function mutateAdminOpeningHours(input: unknown, supabase?: Client) {
  return processAdminOpeningHours(input, supabase);
}

export async function checkAdminOpeningHoursRemoval(input: unknown, supabase?: Client) {
  return processAdminOpeningHours(input, supabase, true);
}
