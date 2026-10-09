import "server-only";

import { z } from "zod";
import type { EntityManager } from "typeorm";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { generateLocationSlug, locationArchiveSchema, locationCurrencies, locationMutationSchema, type LocationMutationResult } from "@/lib/admin/locations-validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { listLocationPublicationPricing } from "@/lib/db/repositories/pricing.repository";
import type { LocationEntity } from "@/lib/db/entities/location.entity";
import { publicationError, publicationReadiness, publicationToday, type PublicationConfiguration } from "@/lib/locations/publication";

const locationSchema = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(),
  address_line1: z.string().nullable(), address_line2: z.string().nullable(),
  city: z.string().nullable(), postal_code: z.string().nullable(), country_code: z.string().nullable(),
  allow_pay_at_club: z.boolean().default(false),
  customer_cancellation_notice_minutes: cancellationNoticeMinutesSchema,
  timezone: z.string(), currency: z.enum(locationCurrencies),
  is_active: z.boolean(), is_public: z.boolean(), archived_at: z.iso.datetime({ offset: true }).nullable(), display_order: z.number().int(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type AdminLocation = z.infer<typeof locationSchema>;
function locationDto(row: LocationEntity) {
  return {
    id: row.id, name: row.name, slug: row.slug,
    address_line1: row.addressLine1, address_line2: row.addressLine2,
    city: row.city, postal_code: row.postalCode, country_code: row.countryCode,
    timezone: row.timezone, currency: row.currency, is_active: row.isActive,
    is_public: row.isPublic, archived_at: row.archivedAt?.toISOString() ?? null,
    display_order: row.displayOrder, allow_pay_at_club: row.allowPayAtClub,
    customer_cancellation_notice_minutes: row.customerCancellationNoticeMinutes,
    created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  };
}

export async function listAdminLocations(supabase?: Awaited<ReturnType<typeof createClient>>, view: "current" | "archived" = "current"): Promise<AdminLocation[]> {
  await requireActiveAdmin(supabase ?? await createClient());
  try {
    const rows = await clubs.listAdminLocations((await getDataSource()).manager, view);
    return z.array(locationSchema).parse(rows.map(locationDto));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.locations_list_failed", kind: failure.kind, code: failure.sqlState }, "Failed to load locations");
    throw new Error("Unable to load locations.");
  }
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
  const slug = id ? "" : generateLocationSlug(fields.name);
  if (!id && !slug) return { ok: false, reason: "invalid-input", fieldErrors: { name: "Use a name containing letters A–Z or numbers to generate a location slug." } };

  const values: clubs.LocationFields = {
    name: fields.name, addressLine1: fields.address_line1, addressLine2: fields.address_line2,
    city: fields.city, postalCode: fields.postal_code, countryCode: fields.country_code,
    timezone: fields.timezone, currency: fields.currency, isActive: fields.is_active,
    isPublic: id ? fields.is_public : false, displayOrder: fields.display_order,
    allowPayAtClub: fields.allow_pay_at_club,
    customerCancellationNoticeMinutes: fields.customer_cancellation_notice_minutes,
  };
  let failureMessage = id && fields.is_public ? "Unable to check public booking readiness." : "Unable to save location.";
  let result: LocationMutationResult;
  try {
    if (!id) {
      const createdId = await inTransaction(async (manager) => {
        await clubs.lockConfigurationForWrite(manager);
        if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
        return clubs.insertLocation(manager, values, slug, new Date());
      });
      result = createdId ? { ok: true, id: createdId } : { ok: false, reason: "not-found" };
    } else {
      result = await inTransaction<LocationMutationResult>(async (manager) => {
        await clubs.lockConfigurationForWrite(manager);
        const [location] = await clubs.lockLocations(manager, [id]);
        if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
        if (!location || location.archivedAt) return { ok: false, reason: "not-found" };
        if (fields.is_public) {
          failureMessage = "Unable to check public booking readiness.";
          const missing = await locationPublicationMissing(manager, id, { ...fields, slug: location.slug, archived_at: null });
          if (missing.length) return { ok: false, reason: "not-ready", message: publicationError(missing) };
          failureMessage = "Unable to save location.";
        }
        const savedId = await clubs.updateUnarchivedLocation(manager, id, values, new Date());
        return savedId ? { ok: true, id: savedId } : { ok: false, reason: "not-found" };
      });
    }
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23505") return { ok: false, reason: "duplicate-slug" };
    logger.error({ event: failureMessage === "Unable to save location." ? "admin.location_save_failed" : "admin.location_readiness_failed",
      actorId: actor.userId, locationId: id, kind: failure.kind, code: failure.sqlState }, "Failed to save location");
    throw new Error(failureMessage);
  }
  if (!result.ok) return result;
  const locationId = result.id;
  logger.info({ event: id ? "admin.location_updated" : "admin.location_created", actorId: actor.userId, locationId, active: fields.is_active, public: values.isPublic }, "Location saved");
  return { ok: true, id: locationId };
}

export async function setAdminLocationArchived(input: unknown, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<LocationMutationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);
  const parsed = locationArchiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: { form: "Choose a valid location." } };
  const { id, archived } = parsed.data;
  let savedId: string | null;
  try {
    savedId = await inTransaction(async (manager) => {
      await clubs.lockConfigurationForWrite(manager);
      await clubs.lockLocations(manager, [id]);
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      return clubs.setLocationArchived(manager, id, archived, new Date());
    });
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.location_archive_failed", actorId: actor.userId, locationId: id, archived,
      kind: failure.kind, code: failure.sqlState }, "Failed to change location archive state");
    throw new Error("Unable to change location archive state.");
  }
  if (!savedId) return { ok: false, reason: "not-found" };
  logger.info({ event: archived ? "admin.location_archived" : "admin.location_restored", actorId: actor.userId, locationId: id }, "Location archive state changed");
  return { ok: true, id };
}

const publicationFactsSchema = z.array(z.object({
  id: z.uuid(), location_opening_hours: z.array(z.object({ id: z.uuid() })),
  courts: z.array(z.object({ id: z.uuid(), environment: z.enum(["indoor", "outdoor"]),
    location_pricing_rules: z.array(z.object({ court_state: z.enum(["indoor", "outdoor", "covered"]), ends_on: z.iso.date().nullable() })),
  })),
}));

export async function listAdminLocationsWithReadiness(view: "current" | "archived" = "current", locationId?: string, supabase?: Awaited<ReturnType<typeof createClient>>) {
  await requireActiveAdmin(supabase ?? await createClient());
  const manager = (await getDataSource()).manager;
  const entities = locationId
    ? [await clubs.findAdminLocation(manager, z.uuid().parse(locationId))].filter((location) => location !== null)
    : await clubs.listAdminLocations(manager, view);
  const locations = z.array(locationSchema).parse(entities.map(locationDto));
  const facts = publicationFactsSchema.parse(await clubs.listAdminPublicationFacts(manager, locations.map(({ id }) => id)));
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return locations.map((location) => {
    const fact = byId.get(location.id);
    if (!fact) throw new Error("Unable to load location configuration.");
    return { ...location, missing: publicationReadiness({ ...location, ...fact }, publicationToday(location.timezone)) };
  });
}

async function locationPublicationMissing(manager: EntityManager, id: string,
  location: Omit<PublicationConfiguration, "location_opening_hours" | "courts">) {
  const hours = await clubs.listLocationOpeningHoursFacts(manager, id);
  const courts = await clubs.listActiveLocationCourts(manager, id);
  const pricing = await listLocationPublicationPricing(manager, id);
  const configuration: PublicationConfiguration = { ...location, location_opening_hours: hours,
    courts: courts.map((court) => ({ id: court.id, environment: court.environment,
      location_pricing_rules: pricing.filter((rule) => rule.courtId === court.id)
        .map((rule) => ({ court_state: rule.courtState, ends_on: rule.endsOn })),
    })),
  };
  return publicationReadiness(configuration, publicationToday(location.timezone));
}

export async function setAdminLocationPublication(input: unknown, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<LocationMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = z.strictObject({ id: z.uuid(), is_public: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: { form: "Choose a valid location." } };
  const { id, is_public } = parsed.data;
  return inTransaction(async (manager): Promise<LocationMutationResult> => {
    await clubs.lockConfigurationForWrite(manager);
    const [location] = await clubs.lockLocations(manager, [id]);
    if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
    if (!location || location.archivedAt) return { ok: false, reason: "not-found" };
    if (is_public) {
      const missing = await locationPublicationMissing(manager, id, locationDto(location));
      if (missing.length) return { ok: false, reason: "not-ready", message: publicationError(missing) };
      if (!location.isActive) return { ok: false, reason: "not-ready", message: "Activate this location before enabling public booking." };
    }
    // Persist only publication intent; concurrent details edits must not be overwritten.
    await clubs.setLocationPublication(manager, id, is_public, new Date());
    return { ok: true, id };
  });
}
