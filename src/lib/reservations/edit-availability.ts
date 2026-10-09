import "server-only";

import { z } from "zod";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { logger } from "@/lib/logger";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findReservationEditLocation, listReservationOpeningHours } from "@/lib/db/repositories/reservations.repository";
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
  const { locationId, timezone, date, occupancy, now } = input;
  if (date < localToday(timezone, now)) throw new Error("Choose a future date at this location.");
  let configuration = input.configuration;
  if (!configuration) {
    try {
      const manager = (await getDataSource()).manager;
      const [location, hours] = await Promise.all([
        findReservationEditLocation(manager, locationId), listReservationOpeningHours(manager, locationId, date),
      ]);
      if (!location) throw new Error("This location is no longer available.");
      configuration = { location, hours };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "This location is no longer available.") throw error;
      logger.error({ event: "reservations.edit_day_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation edit day");
      throw new Error("Unable to load court availability.");
    }
  }
  const location = reservationEditLocationSchema.safeParse(configuration.location);
  const hours = z.array(openingIntervalSchema).safeParse(configuration.hours);
  if (!location.success || !hours.success) throw new Error("Unable to load court availability.");
  if (!location.data || !location.data.is_active || location.data.archived_at
    || location.data.id !== locationId || location.data.timezone !== timezone) {
    throw new Error("This location is no longer available.");
  }
  const courts = location.data.courts.filter((court) => court.is_active).map(({ id, name }) => ({ id, name }));
  const day = buildReservationDay({ date, today: localToday(timezone, now), currentMinute: localMinute(timezone, now),
    courts, hours: hours.data, reservations: occupancy });
  return { date, location: { id: location.data.id, name: location.data.name, timezone: location.data.timezone }, day };
}
