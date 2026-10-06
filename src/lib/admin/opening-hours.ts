import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { weeklyHoursMutationSchema, openingIntervalSchema, timeToMinute, minuteToTime, weekdays, type OpeningHoursMutationResult } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { pricingRuleSchema } from "@/lib/pricing/validation";
import { pricingHasFutureOccurrence } from "@/lib/pricing/resolution";
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

export async function listAdminOpeningHours(supabase?: Client) {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const { data, error } = await client.from("location_opening_hours")
    .select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
    .order("location_id").order("weekday").order("opens_at_minute").order("id");
  const parsed = z.array(openingIntervalSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.opening_hours_list_failed", code: error?.code }, "Failed to load opening hours");
    throw new Error("Unable to load opening hours.");
  }
  return parsed.data;
}

export async function listAdminLocationOpeningHours(locationId: string, supabase?: Client) {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  z.uuid().parse(locationId);
  const { data, error } = await client.from("location_opening_hours")
    .select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
    .eq("location_id", locationId).order("weekday").order("opens_at_minute").order("id");
  const parsed = z.array(openingIntervalSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.opening_hours_list_failed", code: error?.code }, "Failed to load opening hours");
    throw new Error("Unable to load opening hours.");
  }
  return parsed.data;
}

const rpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("not-found") }),
  z.object({ status: z.literal("archived") }),
  z.object({ status: z.literal("overlap"), weekdays: z.array(z.number().int().min(0).max(6)) }),
]);

export async function mutateAdminOpeningHours(input: unknown, supabase?: Client): Promise<OpeningHoursMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = weeklyHoursMutationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { location_id, weekdays, replace_ids, intervals } = parsed.data;
  const location = await client.from("locations").select("archived_at").eq("id", location_id).maybeSingle();
  if (location.error) {
    logger.error({ event: "admin.opening_hours_location_read_failed", actorId: actor.userId, locationId: location_id, code: location.error.code }, "Failed to load location");
    throw new Error("Unable to change opening hours.");
  }
  if (!location.data) return { ok: false, reason: "not-found" };
  if (location.data.archived_at !== null) return { ok: false, reason: "archived" };
  const writer = createBookingWriter();
  const persist = async () => {
    for (let retry = 0; retry < 3; retry++) {
      const snapshot = await writer.rpc("read_opening_hours_command_context", { p_location_id: location_id });
      if (snapshot.error) throw new Error("Unable to read configuration.");
      const context = z.object({ revision: z.number().int(), timezone: z.string(), now: z.string(), pricing: z.array(pricingRuleSchema) }).parse(snapshot.data);
      const today = localToday(context.timezone, new Date(context.now));
      const result = await writer.rpc("commit_location_opening_hours", {
        p_actor: actor.userId, p_revision: context.revision,
        p_applicable_rule_ids: context.pricing.filter((rule) => pricingHasFutureOccurrence(rule, today)).map((rule) => rule.id),
        p_location_id: location_id, p_weekdays: weekdays, p_replace_ids: replace_ids,
        p_opens_at_minutes: intervals.map((interval) => timeToMinute(interval.opens_at)),
        p_closes_at_minutes: intervals.map((interval) => timeToMinute(interval.closes_at)),
      });
      if (result.error?.code === "40001") continue;
      return result;
    }
    throw new Error("Opening hours changed concurrently. Try again.");
  };
  const { data, error } = await persist();
  if (error) {
    if (error.code === "P0001" && error.message === "opening_hours_pricing_conflict") {
      return { ok: false, reason: "pricing-conflict", message: pricingConflictMessage(error.details) };
    }
    if (error.code === "23P01") return { ok: false, reason: "overlap", weekdays };
    if (error.code === "23503") return { ok: false, reason: "not-found" };
    if (error.code === "23514") return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
    logger.error({ event: "admin.opening_hours_mutation_failed", actorId: actor.userId, locationId: location_id, code: error.code }, "Failed to change opening hours");
    throw new Error("Unable to change opening hours.");
  }
  const result = rpcResultSchema.safeParse(data);
  if (!result.success) throw new Error("Unable to change opening hours.");
  if (result.data.status === "not-found") return { ok: false, reason: "not-found" };
  if (result.data.status === "archived") return { ok: false, reason: "archived" };
  if (result.data.status === "overlap") return { ok: false, reason: "overlap", weekdays: result.data.weekdays };
  const refreshed = await client.from("location_opening_hours")
    .select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
    .eq("location_id", location_id).order("weekday").order("opens_at_minute").order("id");
  const rows = z.array(openingIntervalSchema).safeParse(refreshed.data);
  if (refreshed.error || !rows.success) {
    logger.error({ event: "admin.opening_hours_refresh_failed", actorId: actor.userId, locationId: location_id, code: refreshed.error?.code }, "Failed to refresh opening hours");
    throw new Error("Unable to refresh opening hours.");
  }
  logger.info({ event: "admin.opening_hours_changed", actorId: actor.userId, locationId: location_id, weekdayCount: weekdays.length }, "Opening hours changed");
  return { ok: true, intervals: rows.data };
}
