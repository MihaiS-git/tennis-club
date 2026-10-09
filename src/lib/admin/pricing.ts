import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { courtEnvironments } from "./courts-validation";
import { openingIntervalSchema, timeToMinute } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as pricing from "@/lib/db/repositories/pricing.repository";
import { pricingRulesOverlap, pricingRemovalSchema, pricingMutationSchema, pricingRuleSchema, type PricingMutationResult, type PricingRule } from "@/lib/pricing/validation";
import { groupPricingRuleSets, pricingOpeningHoursError } from "@/lib/pricing/resolution";

type Client = Awaited<ReturnType<typeof createClient>>;
export async function listAdminPricingRules(locationId: string, supabase?: Client) {
  await requireActiveAdmin(supabase ?? await createClient());
  z.uuid().parse(locationId);
  let rules: PricingRule[];
  try {
    const rows = await pricing.listLocationPricingRules((await getDataSource()).manager, locationId);
    rules = z.array(pricingRuleSchema).parse(rows.map((row) => ({
      id: row.id, rule_set_id: row.ruleSetId, location_id: row.locationId, court_id: row.courtId,
      court_state: row.courtState, weekday: row.weekday, starts_at_minute: row.startsAtMinute,
      ends_at_minute: row.endsAtMinute, starts_on: row.startsOn, ends_on: row.endsOn,
      price_per_hour_minor: row.pricePerHourMinor, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    })));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.pricing_list_failed", code: failure.sqlState }, "Failed to load pricing rules");
    throw new Error("Unable to load pricing rules.");
  }
  return groupPricingRuleSets(rules);
}

async function mutatePricing(input: unknown, remove: boolean, supabase?: Client): Promise<PricingMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = (remove ? pricingRemovalSchema : pricingMutationSchema).safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { rule_set_id, location_id } = parsed.data;
  let failureMessage = "Unable to change pricing rules.";
  let result: PricingMutationResult;
  try {
    result = await inTransaction(async (manager): Promise<PricingMutationResult> => {
      await clubs.lockConfigurationForWrite(manager);
      const [location] = await clubs.lockLocations(manager, [location_id]);
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      if (!location) return { ok: false, reason: "not-found" };
      if ("starts_at" in parsed.data) {
        const rule = parsed.data;
        const starts_at_minute = timeToMinute(rule.starts_at);
        const ends_at_minute = timeToMinute(rule.ends_at);
        failureMessage = "Unable to validate selected courts.";
        const courtRows = await pricing.findPricingCourts(manager, location.id, rule.court_ids);
        const courts = z.array(z.object({ id: z.uuid(), location_id: z.uuid(), environment: z.enum(courtEnvironments) }))
          .parse(courtRows.map((court) => ({ id: court.id, location_id: court.locationId, environment: court.environment })));
        if (courts.length !== rule.court_ids.length) {
          return { ok: false, reason: "invalid-input", fieldErrors: { court_ids: "Select existing courts belonging to this location." } };
        }
        if (courts.some((court) => (court.environment === "indoor") !== (rule.court_state === "indoor"))) {
          return { ok: false, reason: "invalid-input", fieldErrors: { court_state: "Selected courts must share a valid state: indoor courts use Indoor; outdoor courts use Outdoor or Covered." } };
        }
        failureMessage = "Unable to validate pricing against opening hours.";
        const hoursRows = await clubs.listLocationOpeningHours(manager, location.id);
        const hours = z.array(openingIntervalSchema).parse(hoursRows.map((row) => ({
          id: row.id, location_id: row.locationId, weekday: row.weekday, opens_at_minute: row.opensAtMinute,
          closes_at_minute: row.closesAtMinute, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
        })));
        const hoursError = pricingOpeningHoursError(hours, { location_id: location.id, weekdays: rule.weekdays, starts_at_minute, ends_at_minute });
        if (hoursError) return { ok: false, reason: "invalid-input", fieldErrors: { ends_at: hoursError } };

        // Preserve validation before missing-set discovery. Replacements retain
        // the parent identity and creation time, and replace every child row.
        failureMessage = "Unable to change pricing rules.";
        const existing = rule_set_id ? await pricing.findLocationRuleSet(manager, rule_set_id, location.id) : null;
        if (rule_set_id && !existing) return { ok: false, reason: "not-found" };
        const updatedAt = new Date();
        const rows: Omit<pricing.PricingRuleFields, "ruleSetId">[] = rule.court_ids.flatMap((courtId) => rule.weekdays.map((weekday) => ({
          locationId: location.id, courtId, courtState: rule.court_state, weekday,
          startsAtMinute: starts_at_minute, endsAtMinute: ends_at_minute,
          startsOn: rule.starts_on, endsOn: rule.ends_on, pricePerHourMinor: rule.price_per_hour, updatedAt,
        })));
        const current = (await pricing.listLocationPricingRules(manager, location.id))
          .filter((row) => row.ruleSetId !== existing?.id);
        if (rows.some((row, index) => current.some((other) => pricingRulesOverlap(row, other))
          || rows.slice(0, index).some((other) => pricingRulesOverlap(row, other)))) {
          return { ok: false, reason: "overlap" };
        }
        const savedSetId = existing?.id ?? await pricing.insertRuleSet(manager, location.id);
        if (existing) await pricing.deleteRuleSetRules(manager, savedSetId, location.id);
        await pricing.insertPricingRules(manager, rows.map((row) => ({ ...row, ruleSetId: savedSetId })));
        return { ok: true, id: savedSetId };
      }
      const existing = await pricing.findLocationRuleSet(manager, parsed.data.rule_set_id, location.id);
      if (!existing) return { ok: false, reason: "not-found" };
      const removedId = await pricing.deleteLocationRuleSet(manager, existing.id, location.id);
      return removedId ? { ok: true, id: removedId } : { ok: false, reason: "not-found" };
    });
  } catch (error) {
    // Includes statement and deferred failures; the transaction is rolled back.
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "P0001" && failure.driverMessage === "pricing_outside_opening_hours") {
      return { ok: false, reason: "invalid-input", fieldErrors: { ends_at: "Opening hours changed. Choose a time within the current schedule and try again." } };
    }
    if (failure.sqlState === "23P01" || failure.sqlState === "23505") return { ok: false, reason: "overlap" };
    if (failure.sqlState === "23503") return { ok: false, reason: "not-found" };
    logger.error({ event: failureMessage === "Unable to validate pricing against opening hours." ? "admin.pricing_hours_read_failed" : "admin.pricing_mutation_failed",
      actorId: actor.userId, locationId: location_id, code: failure.sqlState }, "Failed to change pricing");
    throw new Error(failureMessage);
  }
  if (result.ok) logger.info({ event: remove ? "admin.pricing_removed" : "admin.pricing_saved", actorId: actor.userId,
    locationId: location_id, ruleSetId: result.id }, "Pricing changed");
  return result;
}

export async function saveAdminPricingRule(input: unknown, supabase?: Client) { return mutatePricing(input, false, supabase); }
export async function removeAdminPricingRule(input: unknown, supabase?: Client) { return mutatePricing(input, true, supabase); }
