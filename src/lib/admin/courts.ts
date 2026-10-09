import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { courtSurfaces, courtEnvironments, courtMutationSchema, generateCourtSlug, type CourtMutationResult } from "@/lib/admin/courts-validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import * as pricing from "@/lib/db/repositories/pricing.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";

class CourtParentChanged extends Error {}

const courtSchema = z.object({
  id: z.uuid(), location_id: z.uuid(), name: z.string(), slug: z.string(),
  surface: z.enum(courtSurfaces), environment: z.enum(courtEnvironments),
  has_lighting: z.boolean(), is_active: z.boolean(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type AdminCourt = z.infer<typeof courtSchema>;
export async function listAdminCourts(supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AdminCourt[]> {
  await requireActiveAdmin(supabase ?? await createClient());
  try {
    const rows = await clubs.listAdminCourts((await getDataSource()).manager);
    return z.array(courtSchema).parse(rows.map((row) => ({
      id: row.id, location_id: row.locationId, name: row.name, slug: row.slug,
      surface: row.surface, environment: row.environment, has_lighting: row.hasLighting,
      is_active: row.isActive, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    })));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.courts_list_failed", kind: failure.kind, code: failure.sqlState }, "Failed to load courts");
    throw new Error("Unable to load courts.");
  }
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
  const slug = id ? "" : generateCourtSlug(fields.name);
  if (!id && !slug) return { ok: false, reason: "invalid-input", fieldErrors: { name: "Use a name containing letters A–Z or numbers to generate a court slug." } };

  const values: clubs.CourtFields = {
    locationId: fields.location_id, name: fields.name, surface: fields.surface,
    environment: fields.environment, hasLighting: fields.has_lighting, isActive: fields.is_active,
  };
  let result: CourtMutationResult;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        result = await inTransaction<CourtMutationResult>(async (manager) => {
          await clubs.lockConfigurationForWrite(manager);
          const court = id ? await clubs.findCourtConfiguration(manager, id) : null;
          if (id && !court) return { ok: false, reason: "not-found" };
          // Lock both parents in UUID order, then verify discovery under those locks.
          const locations = await clubs.lockLocations(manager, court
            ? [court.locationId, fields.location_id] : [fields.location_id]);
          if (!locations.some((location) => location.id === fields.location_id.toLowerCase())) {
            return { ok: false, reason: "invalid-location" };
          }
          if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
          if (id && court) {
            const authoritative = await clubs.findCourtConfiguration(manager, id);
            if (!authoritative) return { ok: false, reason: "not-found" };
            if (authoritative.locationId !== court.locationId) throw new CourtParentChanged();
            const coverage = await clubs.listCourtCoverage(manager, id);
            if (fields.environment === "indoor" && coverage.length) return { ok: false, reason: "has-coverage" };
            const rules = await pricing.listLocationPricingRules(manager, authoritative.locationId);
            if (rules.some((rule) => rule.courtId === id.toLowerCase()
              && (rule.locationId !== fields.location_id.toLowerCase()
                || (rule.courtState === "indoor") !== (fields.environment === "indoor")))) {
              return { ok: false, reason: "has-pricing" };
            }
          }
          const savedId = id
            ? await clubs.updateCourt(manager, id, values, new Date())
            : await clubs.insertCourt(manager, values, slug, new Date());
          return savedId ? { ok: true, id: savedId } : { ok: false, reason: "not-found" };
        });
        break;
      } catch (error) {
        if (!(error instanceof CourtParentChanged) || attempt === 2) throw error;
      }
    }
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23505") return { ok: false, reason: "duplicate-slug" };
    if (failure.sqlState === "23503") {
      if (failure.constraint === "courts_location_id_fkey") return { ok: false, reason: "invalid-location" };
    }
    logger.error({ event: "admin.court_save_failed", actorId: actor.userId, courtId: id,
      kind: failure.kind, code: failure.sqlState }, "Failed to save court");
    throw new Error("Unable to save court.");
  }
  if (!result.ok) return result;
  const courtId = result.id;
  logger.info({ event: id ? "admin.court_updated" : "admin.court_created", actorId: actor.userId, courtId, locationId: fields.location_id, active: fields.is_active }, "Court saved");
  return { ok: true, id: courtId };
}
