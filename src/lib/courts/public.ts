import { publicationHoursSchema, publicationPricingSchema } from "@/lib/locations/publication";
import "server-only";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { listPublicLocationFacts } from "@/lib/db/repositories/clubs.repository";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { isPubliclyEligible, publicationToday } from "@/lib/locations/publication";
import { mondayWeekday } from "@/lib/pricing/resolution";

const courtSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  surface: z.enum(["clay", "hard", "grass", "carpet"]),
  environment: z.enum(["outdoor", "indoor"]),
  has_lighting: z.boolean(),
  is_active: z.boolean(),
  location_pricing_rules: z.array(publicationPricingSchema),
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
  location_opening_hours: z.array(publicationHoursSchema),
  courts: z.array(courtSchema),
});

export type PublicCourt = Omit<z.infer<typeof courtSchema>, "location_pricing_rules" | "is_active">;
export type PublicOpeningInterval = { opens_at_minute: number; closes_at_minute: number };
export type PublicLocation = Omit<z.infer<typeof locationSchema>, "is_active" | "is_public" | "archived_at" | "location_opening_hours" | "courts"> & {
  courts: PublicCourt[];
  // Weekly intervals of the schedule effective on the location's local publication date.
  todayOpeningHours: PublicOpeningInterval[];
};

function openingHoursOn(hours: readonly z.infer<typeof publicationHoursSchema>[], date: string): PublicOpeningInterval[] {
  const weekday = mondayWeekday(date);
  return hours.filter((h) => h.weekday === weekday && h.starts_on <= date && (!h.ends_on || date <= h.ends_on))
    .map(({ opens_at_minute, closes_at_minute }) => ({ opens_at_minute, closes_at_minute }))
    .sort((a, b) => a.opens_at_minute - b.opens_at_minute);
}

export async function listPublicLocationsWithCourts(): Promise<PublicLocation[]> {
  try {
    const data = await listPublicLocationFacts((await getDataSource()).manager);
    const parsed = z.array(locationSchema).safeParse(data);
    if (!parsed.success) {
      logger.error({ event: "courts.public_read_failed" }, "Failed to load public courts");
      throw new Error("Unable to load courts.");
    }
    return parsed.data.map((location) => ({ location, today: publicationToday(location.timezone) }))
      .filter(({ location, today }) => isPubliclyEligible(location, today))
      .map(({ location, today }) => ({
        id: location.id, name: location.name, slug: location.slug,
        address_line1: location.address_line1, address_line2: location.address_line2,
        city: location.city, postal_code: location.postal_code, country_code: location.country_code,
        timezone: location.timezone, currency: location.currency, allow_pay_at_club: location.allow_pay_at_club,
        courts: location.courts.map((court) => ({
          id: court.id, name: court.name, slug: court.slug, surface: court.surface,
          environment: court.environment, has_lighting: court.has_lighting,
        })),
        todayOpeningHours: openingHoursOn(location.location_opening_hours, today),
      }));
  } catch (error: unknown) {
    logger.error({ event: "courts.public_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load courts.");
  }
}
