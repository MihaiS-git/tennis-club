import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { weeklyHoursMutationSchema, openingIntervalSchema, timeToMinute, type OpeningHoursMutationResult } from "./opening-hours-validation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;

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

const rpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("not-found") }),
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
  const { data, error } = await client.rpc("mutate_location_opening_hours", {
    p_location_id: location_id, p_weekdays: weekdays, p_replace_ids: replace_ids,
    p_opens_at_minutes: intervals.map((interval) => timeToMinute(interval.opens_at)),
    p_closes_at_minutes: intervals.map((interval) => timeToMinute(interval.closes_at)),
  });
  if (error) {
    if (error.code === "23P01") return { ok: false, reason: "overlap", weekdays };
    if (error.code === "23503") return { ok: false, reason: "not-found" };
    if (error.code === "23514") return { ok: false, reason: "invalid-input", fieldErrors: { form: "Check the selected days and times." } };
    logger.error({ event: "admin.opening_hours_mutation_failed", actorId: actor.userId, locationId: location_id, code: error.code }, "Failed to change opening hours");
    throw new Error("Unable to change opening hours.");
  }
  const result = rpcResultSchema.safeParse(data);
  if (!result.success) throw new Error("Unable to change opening hours.");
  if (result.data.status === "not-found") return { ok: false, reason: "not-found" };
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
