import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { generateLocationSlug, locationArchiveSchema, locationCurrencies, locationMutationSchema, type LocationMutationResult } from "@/lib/admin/locations-validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const locationSchema = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(),
  address_line1: z.string().nullable(), address_line2: z.string().nullable(),
  city: z.string().nullable(), postal_code: z.string().nullable(), country_code: z.string().nullable(),
  timezone: z.string(), currency: z.enum(locationCurrencies),
  is_active: z.boolean(), archived_at: z.iso.datetime({ offset: true }).nullable(), display_order: z.number().int(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type AdminLocation = z.infer<typeof locationSchema>;
const columns = "id, name, slug, address_line1, address_line2, city, postal_code, country_code, timezone, currency, is_active, archived_at, display_order, created_at, updated_at";

export async function listAdminLocations(supabase?: Awaited<ReturnType<typeof createClient>>, view: "current" | "archived" = "current"): Promise<AdminLocation[]> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const query = client.from("locations").select(columns);
  const { data, error } = await (view === "archived" ? query.not("archived_at", "is", null) : query.is("archived_at", null))
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
    ? client.from("locations").update(values).eq("id", id).is("archived_at", null)
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

export async function setAdminLocationArchived(input: unknown, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<LocationMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = locationArchiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: { form: "Choose a valid location." } };
  const { id, archived } = parsed.data;
  const query = client.from("locations").update({ archived_at: archived ? new Date().toISOString() : null,
    is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
  const { data, error } = await (archived ? query.is("archived_at", null) : query.not("archived_at", "is", null))
    .select("id").maybeSingle();
  if (error) {
    logger.error({ event: "admin.location_archive_failed", actorId: actor.userId, locationId: id, archived, code: error.code }, "Failed to change location archive state");
    throw new Error("Unable to change location archive state.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  logger.info({ event: archived ? "admin.location_archived" : "admin.location_restored", actorId: actor.userId, locationId: id }, "Location archive state changed");
  return { ok: true, id };
}
