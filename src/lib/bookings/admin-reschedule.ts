import "server-only";

import { createClient } from "@/lib/supabase/server";
import { requireAdminReservationRole } from "@/lib/reservations/authorization";
import { loadBookingEditDay, runBookingReschedule } from "./reschedule";
import type { BookingRescheduleResult } from "./reschedule";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;

export async function getAdminBookingEditDay(id: unknown, date: unknown, supabase?: Client, now = new Date()) {
  const client = supabase ?? await createClient();
  await requireAdminReservationRole(client);
  return loadBookingEditDay(id, date, client, "admin", now);
}

export async function rescheduleCustomerBookingAsAdmin(input: unknown, supabase?: Client): Promise<BookingRescheduleResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  try {
    return await runBookingReschedule(input, client, actor.userId, "admin");
  } catch {
    logger.error({ event: "bookings.admin_reschedule_failed", actorId: actor.userId }, "Unable to reschedule customer booking");
    return { ok: false, message: "This booking or interval is no longer available to reschedule." };
  }
}
