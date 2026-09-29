import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { generateLocationSlug, locationCurrencies, locationMutationSchema, type LocationMutationResult } from "@/lib/admin/locations-validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const locationSchema = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(),
  address_line1: z.string().nullable(), address_line2: z.string().nullable(),
  city: z.string().nullable(), postal_code: z.string().nullable(), country_code: z.string().nullable(),
  timezone: z.string(), currency: z.enum(locationCurrencies),
  is_active: z.boolean(), display_order: z.number().int(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type AdminLocation = z.infer<typeof locationSchema>;
const columns = "id, name, slug, address_line1, address_line2, city, postal_code, country_code, timezone, currency, is_active, display_order, created_at, updated_at";

export async function listAdminLocations(supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AdminLocation[]> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const { data, error } = await client.from("locations").select(columns)
    .order("display_order").order("name").order("id");
  const parsed = z.array(locationSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.locations_list_failed", code: error?.code }, "Failed to load locations");
    throw new Error("Unable to load locations.");
  }
  return parsed.data;
}

export async function saveAdminLocation(input: unknown, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<LocationMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = locationMutationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    }
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { id, fields } = parsed.data;
  const slug = id ? undefined : generateLocationSlug(fields.name);
  if (!id && !slug) return { ok: false, reason: "invalid-input", fieldErrors: { name: "Use a name containing letters A–Z or numbers to generate a location slug." } };

  // The strict schema contains only editable fields. Identity, slug on edit,
  // creation time, and update time cannot be assigned by the caller.
  const values = { ...fields, updated_at: new Date().toISOString() };
  const query = id
    ? client.from("locations").update(values).eq("id", id)
    : client.from("locations").insert({ ...values, slug });
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "duplicate-slug" };
    logger.error({ event: "admin.location_save_failed", actorId: actor.userId, locationId: id, code: error.code }, "Failed to save location");
    throw new Error("Unable to save location.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  const locationId = z.uuid().parse(data.id);
  logger.info({ event: id ? "admin.location_updated" : "admin.location_created", actorId: actor.userId, locationId, active: fields.is_active }, "Location saved");
  return { ok: true, id: locationId };
}
