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
import { openingIntervalSchema, type OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { coveragePeriodSchema, type CoveragePeriod } from "@/lib/courts/coverage-validation";
import { pricingRuleSchema, type PricingRule } from "@/lib/pricing/validation";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { buildCourtDay, courtSlotRates, localMinute, localToday } from "./calendar";
import { listPublicLocationsWithCourts, type PublicLocation } from "./public";

const calendarReservationSchema = z.object({
  court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int().min(0).max(1439),
  ends_at_minute: z.number().int().min(1).max(1440),
});

type PublicDayConfiguration = { hours: OpeningInterval[]; coverage: CoveragePeriod[]; pricing: PricingRule[] };

// Effective opening hours, court coverage and pricing of one public location date.
export async function readPublicDayConfiguration(manager: EntityManager, location: PublicLocation, date: string) {
  return (await readPublicDayConfigurations(manager, [{ location, date }]))?.[0] ?? null;
}

// Batched form for distinct locations, each on its own local date: three reads in total,
// grouped back per location; null when any row is malformed.
async function readPublicDayConfigurations(manager: EntityManager,
  days: readonly { location: PublicLocation; date: string }[]): Promise<PublicDayConfiguration[] | null> {
  const reads = days.map(({ location, date }) => ({ locationId: location.id,
    courtIds: location.courts.map((court) => court.id), weekday: mondayWeekday(date), date }));
  const [hoursResult, coverageResult, pricingResult] = await readIndependently(manager, [
    () => listPublicDayOpeningHours(manager, reads),
    () => listPublicDayCoverage(manager, reads),
    () => listPublicDayPricing(manager, reads),
  ]);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult);
  const coverage = z.array(coveragePeriodSchema).safeParse(coverageResult);
  const pricing = z.array(pricingRuleSchema).safeParse(pricingResult);
  if (!hours.success || !coverage.success || !pricing.success) return null;
  const courtLocation = new Map(reads.flatMap((read) => read.courtIds.map((courtId) => [courtId, read.locationId])));
  return reads.map(({ locationId }) => ({
    hours: hours.data.filter((row) => row.location_id === locationId),
    coverage: coverage.data.filter((row) => courtLocation.get(row.court_id) === locationId),
    pricing: pricing.data.filter((row) => courtLocation.get(row.court_id) === locationId),
  }));
}

// Live court occupancy of one public location date; null when a row is malformed.
export async function readPublicDayReservations(manager: EntityManager, location: PublicLocation, date: string,
  excludeReservationId?: string) {
  const reservations = z.array(calendarReservationSchema)
    .safeParse(await listPublicDayOccupancy(manager, location.id, location.courts.map((court) => court.id), date, excludeReservationId));
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
    return buildCourtDay({ timezone: location.timezone, date, today, currentMinute: localMinute(location.timezone, now), courts: location.courts,
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
    const days = locations.map((location) => ({ location, date: localToday(location.timezone, now) }));
    const configurations = days.length ? await readPublicDayConfigurations(manager, days) : [];
    if (!configurations) {
      logger.error({ event: "courts.public_overview_read_failed" }, "Failed to load location day");
      throw new Error("Unable to load courts.");
    }
    return days.map(({ location, date: today }, index) => {
      const configuration = configurations[index];
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
    });
  } catch (error: unknown) {
    logger.error({ event: "courts.public_overview_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load courts.");
  }
}
