import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { courtEnvironments } from "./courts-validation";
import { openingIntervalSchema, timeToMinute, weekdays } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pricingRemovalSchema, pricingMutationSchema, pricingRuleSchema, type PricingMutationResult } from "@/lib/pricing/validation";
import { fitsOpeningHours, groupPricingRuleSets } from "@/lib/pricing/resolution";

type Client = Awaited<ReturnType<typeof createClient>>;
const columns = "id, rule_set_id, location_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute, starts_on, ends_on, price_per_hour_minor, created_at, updated_at";

export async function listAdminPricingRules(locationId: string, supabase?: Client) {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  z.uuid().parse(locationId);
  const { data, error } = await client.from("location_pricing_rules").select(columns).eq("location_id", locationId);
  const parsed = z.array(pricingRuleSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.pricing_list_failed", code: error?.code }, "Failed to load pricing rules");
    throw new Error("Unable to load pricing rules.");
  }
  return groupPricingRuleSets(parsed.data);
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
  let result;
  if ("starts_at" in parsed.data) {
    const rule = parsed.data;
    const starts_at_minute = timeToMinute(rule.starts_at);
    const ends_at_minute = timeToMinute(rule.ends_at);
    const { data: courtData, error: courtError } = await client.from("courts").select("id, location_id, environment")
      .eq("location_id", location_id).in("id", rule.court_ids);
    const courts = z.array(z.object({ id: z.uuid(), location_id: z.uuid(), environment: z.enum(courtEnvironments) })).safeParse(courtData);
    if (courtError || !courts.success) throw new Error("Unable to validate selected courts.");
    if (courts.data.length !== rule.court_ids.length) {
      return { ok: false, reason: "invalid-input", fieldErrors: { court_ids: "Select existing courts belonging to this location." } };
    }
    if (courts.data.some((court) => (court.environment === "indoor") !== (rule.court_state === "indoor"))) {
      return { ok: false, reason: "invalid-input", fieldErrors: { court_state: "Selected courts must share a valid state: indoor courts use Indoor; outdoor courts use Outdoor or Covered." } };
    }
    const { data, error } = await client.from("location_opening_hours").select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
      .eq("location_id", location_id).in("weekday", rule.weekdays);
    const hours = z.array(openingIntervalSchema).safeParse(data);
    if (error || !hours.success) {
      logger.error({ event: "admin.pricing_hours_read_failed", code: error?.code }, "Failed to validate pricing hours");
      throw new Error("Unable to validate pricing against opening hours.");
    }
    // All selected courts share the location's schedule. Check every target day before any write.
    const incompatibleDays = rule.weekdays.filter((weekday) => !fitsOpeningHours(hours.data, { location_id, weekday, starts_at_minute, ends_at_minute }));
    if (incompatibleDays.length) {
      return { ok: false, reason: "invalid-input", fieldErrors: { ends_at: `Pricing must fit within one configured opening interval for ${incompatibleDays.map((day) => weekdays[day]).join(", ")}. Configure opening hours first if none exist.` } };
    }
    result = await client.rpc("save_pricing_rule_set", {
      p_rule_set_id: rule_set_id ?? null, p_location_id: location_id, p_court_ids: rule.court_ids, p_weekdays: rule.weekdays,
      p_court_state: rule.court_state, p_starts_at_minute: starts_at_minute, p_ends_at_minute: ends_at_minute,
      p_starts_on: rule.starts_on, p_ends_on: rule.ends_on, p_price_per_hour_minor: rule.price_per_hour,
      p_updated_at: new Date().toISOString(),
    });
  } else {
    result = await client.rpc("remove_pricing_rule_set", { p_rule_set_id: rule_set_id, p_location_id: location_id });
  }
  const { data, error } = result;
  if (error) {
    if (error.code === "23P01" || error.code === "23505") return { ok: false, reason: "overlap" };
    if (error.code === "23503") return { ok: false, reason: "not-found" };
    logger.error({ event: "admin.pricing_mutation_failed", actorId: actor.userId, locationId: location_id, code: error.code }, "Failed to change pricing");
    throw new Error("Unable to change pricing rules.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  const ruleSetId = z.uuid().parse(data);
  logger.info({ event: remove ? "admin.pricing_removed" : "admin.pricing_saved", actorId: actor.userId, locationId: location_id, ruleSetId }, "Pricing changed");
  return { ok: true, id: ruleSetId };
}

export async function saveAdminPricingRule(input: unknown, supabase?: Client) { return mutatePricing(input, false, supabase); }
export async function removeAdminPricingRule(input: unknown, supabase?: Client) { return mutatePricing(input, true, supabase); }
