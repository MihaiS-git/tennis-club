import "server-only";

import { z } from "zod";
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
  suppliedClient?: Awaited<ReturnType<typeof createClient>>) {
  const client = suppliedClient ?? await createClient();
  const courtIds = location.courts.map((court) => court.id);
  const [hoursResult, coverageResult, pricingResult, reservationResult] = await Promise.all([
    client.from("location_opening_hours")
      .select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
      .eq("location_id", location.id).eq("weekday", mondayWeekday(date)),
    client.from("court_coverage_periods")
      .select("id, court_id, starts_on, ends_on, created_at, updated_at")
      .in("court_id", courtIds).lte("starts_on", date).or(`ends_on.is.null,ends_on.gte.${date}`),
    client.from("location_pricing_rules")
      .select("id, rule_set_id, location_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute, starts_on, ends_on, price_per_hour_minor, created_at, updated_at")
      .in("court_id", courtIds).eq("weekday", mondayWeekday(date))
      .or(`starts_on.is.null,starts_on.lte.${date}`).or(`ends_on.is.null,ends_on.gte.${date}`),
    client.from("court_reservations")
      .select("court_id, booking_date, starts_at_minute, ends_at_minute")
      .in("court_id", courtIds).eq("booking_date", date),
  ]);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult.data);
  const coverage = z.array(coveragePeriodSchema).safeParse(coverageResult.data);
  const pricing = z.array(pricingRuleSchema).safeParse(pricingResult.data);
  const reservations = z.array(calendarReservationSchema).safeParse(reservationResult.data);
  if (hoursResult.error || coverageResult.error || pricingResult.error || reservationResult.error
    || !hours.success || !coverage.success || !pricing.success || !reservations.success) {
    logger.error({ event: "courts.public_calendar_read_failed", hoursCode: hoursResult.error?.code,
      coverageCode: coverageResult.error?.code, pricingCode: pricingResult.error?.code,
      reservationCode: reservationResult.error?.code }, "Failed to load court day");
    throw new Error("Unable to load court availability.");
  }
  return buildCourtDay({ date, today, currentMinute: localMinute(location.timezone, now), courts: location.courts,
    hours: hours.data, coverage: coverage.data, pricing: pricing.data, reservations: reservations.data });
}
