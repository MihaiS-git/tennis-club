import "server-only";

import { createClient } from "@/lib/supabase/server";
import { requireAdminReservationRole } from "@/lib/reservations/authorization";
import { loadBookingEditDay, runBookingReschedule } from "./reschedule";
import type { BookingRescheduleResult } from "./reschedule";

type Client = Awaited<ReturnType<typeof createClient>>;
export type { BookingEditContext as AdminBookingEditContext, BookingRescheduleResult as AdminBookingRescheduleResult } from "./reschedule";

export async function getAdminBookingEditDay(id: unknown, date: unknown, supabase?: Client, now = new Date()) {
  const client = supabase ?? await createClient();
  await requireAdminReservationRole(client);
  return loadBookingEditDay(id, date, client, "read_admin_booking_edit_availability", now);
}

export async function rescheduleCustomerBookingAsAdmin(input: unknown, supabase?: Client): Promise<BookingRescheduleResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  return runBookingReschedule(input, client, actor.userId, "reschedule_admin_customer_booking");
}

