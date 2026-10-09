import "server-only";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { listPublicLocationFacts } from "@/lib/db/repositories/clubs.repository";
import { createClient } from "@/lib/supabase/server";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { isPubliclyEligible, publicationToday } from "@/lib/locations/publication";

const courtSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  surface: z.enum(["clay", "hard", "grass", "carpet"]),
  environment: z.enum(["outdoor", "indoor"]),
  has_lighting: z.boolean(),
  is_active: z.boolean(),
  location_pricing_rules: z.array(z.object({ court_state: z.enum(["indoor", "outdoor", "covered"]), ends_on: z.iso.date().nullable() })),
});
const locationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string().nullable(),
  timezone: z.string(),
  currency: z.enum(locationCurrencies),
  allow_pay_at_club: z.boolean().default(false),
  is_active: z.boolean(),
  is_public: z.boolean(),
  archived_at: z.iso.datetime({ offset: true }).nullable(),
  location_opening_hours: z.array(z.object({ id: z.uuid() })),
  courts: z.array(courtSchema),
});

export type PublicCourt = Omit<z.infer<typeof courtSchema>, "location_pricing_rules" | "is_active">;
export type PublicLocation = Omit<z.infer<typeof locationSchema>, "is_active" | "is_public" | "archived_at" | "location_opening_hours" | "courts"> & { courts: PublicCourt[] };

export async function listPublicLocationsWithCourts(
  _supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<PublicLocation[]> {
  void _supabase; // Retained only for fixture compatibility.
  try {
    const data = await listPublicLocationFacts((await getDataSource()).manager);
    const parsed = z.array(locationSchema).safeParse(data);
    if (!parsed.success) {
      logger.error({ event: "courts.public_read_failed" }, "Failed to load public courts");
      throw new Error("Unable to load courts.");
    }
    return parsed.data.filter((location) => isPubliclyEligible(location, publicationToday(location.timezone)))
      .map((location) => ({
        id: location.id, name: location.name, slug: location.slug,
        address_line1: location.address_line1, address_line2: location.address_line2,
        city: location.city, postal_code: location.postal_code, country_code: location.country_code,
        timezone: location.timezone, currency: location.currency, allow_pay_at_club: location.allow_pay_at_club,
        courts: location.courts.map((court) => ({
          id: court.id, name: court.name, slug: court.slug, surface: court.surface,
          environment: court.environment, has_lighting: court.has_lighting,
        })),
      }));
  } catch (error: unknown) {
    logger.error({ event: "courts.public_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load courts.");
  }
}
