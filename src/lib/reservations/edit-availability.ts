import "server-only";

import { z } from "zod";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { logger } from "@/lib/logger";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { createClient } from "@/lib/supabase/server";
import { buildReservationDay, type Occupancy } from "./domain";

export const reservationEditLocationSchema = z.object({ id: z.uuid(), name: z.string(), timezone: z.string(),
  is_active: z.boolean(), archived_at: z.string().nullable(),
  courts: z.array(z.object({ id: z.uuid(), name: z.string(), is_active: z.boolean() })) });

export async function loadReservationEditDayForLocation(input: {
  client: Awaited<ReturnType<typeof createClient>>; locationId: string; timezone: string;
  date: string; occupancy: Occupancy[]; now: Date;
  configuration?: { location: z.infer<typeof reservationEditLocationSchema>; hours: z.infer<typeof openingIntervalSchema>[] };
}) {
  const { client, locationId, timezone, date, occupancy, now } = input;
  if (date < localToday(timezone, now)) throw new Error("Choose a future date at this location.");
  const [locationResult, hoursResult] = input.configuration
    ? [{ data: input.configuration.location, error: null }, { data: input.configuration.hours, error: null }]
    : await Promise.all([
    client.from("locations").select("id, name, timezone, is_active, archived_at, courts(id, name, is_active)")
      .eq("id", locationId).eq("courts.is_active", true).maybeSingle(),
    client.from("location_opening_hours").select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
      .eq("location_id", locationId).eq("weekday", mondayWeekday(date)),
  ]);
  const location = reservationEditLocationSchema.nullable().safeParse(locationResult.data);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult.data);
  if (locationResult.error || hoursResult.error || !location.success || !hours.success) {
    logger.error({ event: "reservations.edit_day_read_failed", locationCode: locationResult.error?.code,
      hoursCode: hoursResult.error?.code }, "Failed to load reservation edit day");
    throw new Error("Unable to load court availability.");
  }
  if (!location.data || !location.data.is_active || location.data.archived_at
    || location.data.id !== locationId || location.data.timezone !== timezone) {
    throw new Error("This location is no longer available.");
  }
  const courts = location.data.courts.filter((court) => court.is_active).map(({ id, name }) => ({ id, name }));
  const day = buildReservationDay({ date, today: localToday(timezone, now), currentMinute: localMinute(timezone, now),
    courts, hours: hours.data, reservations: occupancy });
  return { date, location: { id: location.data.id, name: location.data.name, timezone: location.data.timezone }, day };
}
