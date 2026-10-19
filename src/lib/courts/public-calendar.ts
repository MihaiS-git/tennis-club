import "server-only";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { readIndependently } from "@/lib/db/transaction";
import { listPublicDayOpeningHours, listPublicDayCoverage } from "@/lib/db/repositories/clubs.repository";
import { listPublicDayPricing } from "@/lib/db/repositories/pricing.repository";
import { listPublicDayOccupancy } from "@/lib/db/repositories/reservations.repository";
import { logger } from "@/lib/logger";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { coveragePeriodSchema } from "@/lib/courts/coverage-validation";
import { pricingRuleSchema } from "@/lib/pricing/validation";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { buildCourtDay, courtSlotRates, localMinute, localToday } from "./calendar";
import { listPublicLocationsWithCourts, type PublicLocation } from "./public";

const calendarReservationSchema = z.object({
  court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int().min(0).max(1439),
  ends_at_minute: z.number().int().min(1).max(1440),
});

// Effective opening hours, court coverage and pricing of one public location date.
export async function readPublicDayConfiguration(manager: EntityManager, location: PublicLocation, date: string) {
  const courtIds = location.courts.map((court) => court.id);
  const [hoursResult, coverageResult, pricingResult] = await readIndependently(manager, [
    () => listPublicDayOpeningHours(manager, location.id, mondayWeekday(date), date),
    () => listPublicDayCoverage(manager, location.id, courtIds, date),
    () => listPublicDayPricing(manager, location.id, courtIds, mondayWeekday(date), date),
  ]);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult);
  const coverage = z.array(coveragePeriodSchema).safeParse(coverageResult);
  const pricing = z.array(pricingRuleSchema).safeParse(pricingResult);
  if (!hours.success || !coverage.success || !pricing.success) return null;
  return { hours: hours.data, coverage: coverage.data, pricing: pricing.data };
}

// Live court occupancy of one public location date; null when a row is malformed.
export async function readPublicDayReservations(manager: EntityManager, location: PublicLocation, date: string) {
  const reservations = z.array(calendarReservationSchema)
    .safeParse(await listPublicDayOccupancy(manager, location.id, location.courts.map((court) => court.id), date));
  return reservations.success ? reservations.data : null;
}

export async function getPublicCourtDay(location: PublicLocation, date: string, today: string, now: Date) {
  try {
    const manager = (await getDataSource()).manager;
    const [configuration, reservations] = await Promise.all([
      readPublicDayConfiguration(manager, location, date),
      readPublicDayReservations(manager, location, date),
    ]);
    if (!configuration || !reservations) {
      logger.error({ event: "courts.public_calendar_read_failed" }, "Failed to load court day");
      throw new Error("Unable to load court availability.");
    }
    return buildCourtDay({ date, today, currentMinute: localMinute(location.timezone, now), courts: location.courts,
      ...configuration, reservations });
  } catch (error: unknown) {
    logger.error({ event: "courts.public_calendar_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load court availability.");
  }
}

export type PublicLocationToday = PublicLocation & {
  openingHours: { opens_at_minute: number; closes_at_minute: number }[];
  // Lowest configured hourly rate of any open, priced court slot today; not an availability claim.
  startingRateMinor: number | null;
};

export async function listPublicLocationsToday(now = new Date()): Promise<PublicLocationToday[]> {
  const locations = await listPublicLocationsWithCourts();
  try {
    const manager = (await getDataSource()).manager;
    return await Promise.all(locations.map(async (location) => {
      const today = localToday(location.timezone, now);
      const configuration = await readPublicDayConfiguration(manager, location, today);
      if (!configuration) {
        logger.error({ event: "courts.public_overview_read_failed" }, "Failed to load location day");
        throw new Error("Unable to load courts.");
      }
      const openingHours = configuration.hours
        .map(({ opens_at_minute, closes_at_minute }) => ({ opens_at_minute, closes_at_minute }))
        .sort((a, b) => a.opens_at_minute - b.opens_at_minute);
      // Same half-hour slot grid as the booking timetable (buildCourtDay).
      const first = openingHours.length ? Math.floor(Math.min(...openingHours.map((h) => h.opens_at_minute)) / 30) * 30 : 0;
      const last = openingHours.length ? Math.ceil(Math.max(...openingHours.map((h) => h.closes_at_minute)) / 30) * 30 : 0;
      const times = Array.from({ length: (last - first) / 30 }, (_, index) => first + index * 30);
      const rates = location.courts.flatMap((court) => courtSlotRates({ court, date: today, times, ...configuration }).rates)
        .filter((rate): rate is number => rate !== null);
      return { ...location, openingHours, startingRateMinor: rates.length ? Math.min(...rates) : null };
    }));
  } catch (error: unknown) {
    logger.error({ event: "courts.public_overview_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load courts.");
  }
}
