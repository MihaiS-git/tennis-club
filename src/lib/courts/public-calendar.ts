import "server-only";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { listPublicDayOpeningHours, listPublicDayCoverage } from "@/lib/db/repositories/clubs.repository";
import { listPublicDayPricing } from "@/lib/db/repositories/pricing.repository";
import { listPublicDayOccupancy } from "@/lib/db/repositories/reservations.repository";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { coveragePeriodSchema } from "@/lib/courts/coverage-validation";
import { pricingRuleSchema } from "@/lib/pricing/validation";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { buildCourtDay, localMinute } from "./calendar";
import type { PublicLocation } from "./public";

const calendarReservationSchema = z.object({
  court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int().min(0).max(1439),
  ends_at_minute: z.number().int().min(1).max(1440),
});

export async function getPublicCourtDay(location: PublicLocation, date: string, today: string, now: Date,
  _suppliedClient?: Awaited<ReturnType<typeof createClient>>) {
  void _suppliedClient; // Retained only for fixture compatibility.
  try {
    const manager = (await getDataSource()).manager;
    const courtIds = location.courts.map((court) => court.id);
    const [hoursResult, coverageResult, pricingResult, reservationResult] = await Promise.all([
      listPublicDayOpeningHours(manager, location.id, mondayWeekday(date)),
      listPublicDayCoverage(manager, location.id, courtIds, date),
      listPublicDayPricing(manager, location.id, courtIds, mondayWeekday(date), date),
      listPublicDayOccupancy(manager, location.id, courtIds, date),
    ]);
    const hours = z.array(openingIntervalSchema).safeParse(hoursResult);
    const coverage = z.array(coveragePeriodSchema).safeParse(coverageResult);
    const pricing = z.array(pricingRuleSchema).safeParse(pricingResult);
    const reservations = z.array(calendarReservationSchema).safeParse(reservationResult);
    if (!hours.success || !coverage.success || !pricing.success || !reservations.success) {
      logger.error({ event: "courts.public_calendar_read_failed" }, "Failed to load court day");
      throw new Error("Unable to load court availability.");
    }
    return buildCourtDay({ date, today, currentMinute: localMinute(location.timezone, now), courts: location.courts,
      hours: hours.data, coverage: coverage.data, pricing: pricing.data, reservations: reservations.data });
  } catch (error: unknown) {
    logger.error({ event: "courts.public_calendar_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load court availability.");
  }
}
