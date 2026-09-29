import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { courtSurfaces, courtEnvironments, courtMutationSchema, generateCourtSlug, type CourtMutationResult } from "@/lib/admin/courts-validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const courtSchema = z.object({
  id: z.uuid(), location_id: z.uuid(), name: z.string(), slug: z.string(),
  surface: z.enum(courtSurfaces), environment: z.enum(courtEnvironments),
  has_lighting: z.boolean(), is_active: z.boolean(), display_order: z.number().int(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type AdminCourt = z.infer<typeof courtSchema>;
const columns = "id, location_id, name, slug, surface, environment, has_lighting, is_active, display_order, created_at, updated_at";

export async function listAdminCourts(supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AdminCourt[]> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const { data, error } = await client.from("courts").select(columns)
    .order("display_order").order("name").order("id");
  const parsed = z.array(courtSchema).safeParse(data);
  if (error || !parsed.success) {
    logger.error({ event: "admin.courts_list_failed", code: error?.code }, "Failed to load courts");
    throw new Error("Unable to load courts.");
  }
  return parsed.data;
}

export async function saveAdminCourt(input: unknown, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<CourtMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = courtMutationSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, reason: "invalid-input", fieldErrors };
  }
  const { id, fields } = parsed.data;
  const slug = id ? undefined : generateCourtSlug(fields.name);
  if (!id && !slug) return { ok: false, reason: "invalid-input", fieldErrors: { name: "Use a name containing letters A–Z or numbers to generate a court slug." } };

  // Only validated editable fields are persisted; edits never assign a slug.
  const values = { ...fields, updated_at: new Date().toISOString() };
  const query = id
    ? client.from("courts").update(values).eq("id", id)
    : client.from("courts").insert({ ...values, slug });
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "duplicate-slug" };
    if (error.code === "23503") return { ok: false, reason: "invalid-location" };
    logger.error({ event: "admin.court_save_failed", actorId: actor.userId, courtId: id, code: error.code }, "Failed to save court");
    throw new Error("Unable to save court.");
  }
  if (!data) return { ok: false, reason: "not-found" };
  const courtId = z.uuid().parse(data.id);
  logger.info({ event: id ? "admin.court_updated" : "admin.court_created", actorId: actor.userId, courtId, locationId: fields.location_id, active: fields.is_active }, "Court saved");
  return { ok: true, id: courtId };
}
