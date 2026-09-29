import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "./authorization";
import { openingHoursMutationSchema, openingHoursRemovalSchema, openingIntervalSchema, timeToMinute, type OpeningHoursMutationResult } from "./opening-hours-validation";
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

async function mutateOpeningHours(input: unknown, remove: boolean, supabase?: Client): Promise<OpeningHoursMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = (remove ? openingHoursRemovalSchema : openingHoursMutationSchema).safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { id, location_id } = parsed.data;
  let query;
  if (remove && id) {
    query = client.from("location_opening_hours").delete().eq("id", id).eq("location_id", location_id);
  } else if ("opens_at" in parsed.data) {
    const values = {
      weekday: parsed.data.weekday,
      opens_at_minute: timeToMinute(parsed.data.opens_at),
      closes_at_minute: timeToMinute(parsed.data.closes_at),
      updated_at: new Date().toISOString(),
    };
    query = id
      ? client.from("location_opening_hours").update(values).eq("id", id).eq("location_id", location_id)
      : client.from("location_opening_hours").insert({ location_id, ...values });
  } else {
    return { ok: false, reason: "not-found" };
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    if (error.code === "23P01") return { ok: false, reason: "overlap" };
    if (error.code === "23503") return { ok: false, reason: "not-found" };
    logger.error({ event: "admin.opening_hours_mutation_failed", actorId: actor.userId, locationId: location_id, code: error.code }, "Failed to change opening hours");
    throw new Error("Unable to change opening hours.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  const intervalId = z.uuid().parse(data.id);
  logger.info({ event: remove ? "admin.opening_hours_removed" : "admin.opening_hours_saved", actorId: actor.userId, locationId: location_id, intervalId }, "Opening hours changed");
  return { ok: true, id: intervalId };
}

export async function saveAdminOpeningHours(input: unknown, supabase?: Client) {
  return mutateOpeningHours(input, false, supabase);
}
export async function removeAdminOpeningHours(input: unknown, supabase?: Client) {
  return mutateOpeningHours(input, true, supabase);
}
