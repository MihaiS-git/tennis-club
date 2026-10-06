import "server-only";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { localMinute, localStartInstant, localToday } from "@/lib/courts/local-time";
import { logger } from "@/lib/logger";
import { minorAmountSchema } from "@/lib/pricing/money";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { createClient } from "@/lib/supabase/server";
import type { PersonalCustomerBooking } from "./personal";

const bookingSelectSchema = z.object({
  id: z.uuid(), customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(),
  cancellation_notice_minutes: cancellationNoticeMinutesSchema,
  total_amount_minor: minorAmountSchema, currency: z.enum(locationCurrencies),
  reservation: z.object({
    booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    court: z.object({ name: z.string(), location: z.object({ name: z.string(), timezone: z.string() }) }),
  }),
});

export async function listOwnUpcomingCustomerBookings(
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date(),
): Promise<PersonalCustomerBooking[]> {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  // Private contact columns have no browser SELECT grants. Bind privileged access
  // to the verified active account and confirmed, active rows in every query.
  const reader = createBookingWriter();
  const upcoming: PersonalCustomerBooking[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const result = await reader.from("bookings").select(`
      id, customer_name, customer_email, customer_phone,
      cancellation_notice_minutes, total_amount_minor, currency,
      reservation:court_reservations!inner(booking_date, starts_at_minute, ends_at_minute,
        court:courts!inner(name, location:locations!inner(name, timezone)))
    `).eq("account_user_id", account.userId).eq("status", "confirmed")
      .eq("reservation.status", "active")
      .order("reservation(booking_date)").order("reservation(starts_at_minute)").order("id")
      .range(offset, offset + pageSize - 1);
    const parsed = z.array(bookingSelectSchema).safeParse(result.data);
    if (result.error || !parsed.success) {
      logger.error({ event: "activity.bookings_read_failed", code: result.error?.code }, "Failed to load personal bookings");
      throw new Error("Unable to load your bookings.");
    }
    for (const { reservation, ...booking } of parsed.data) {
      const { court, ...interval } = reservation;
      const today = localToday(court.location.timezone, now);
      if (interval.booking_date < today || (interval.booking_date === today
        && interval.ends_at_minute <= localMinute(court.location.timezone, now))) continue;
      upcoming.push({ ...booking, ...interval, location_name: court.location.name,
        location_timezone: court.location.timezone, court_name: court.name,
        starts_at_instant: localStartInstant(court.location.timezone, interval.booking_date, interval.starts_at_minute) });
    }
    // Finished rows must not consume the PostgREST row cap and hide future rows.
    if (parsed.data.length < pageSize) break;
  }
  return upcoming;
}
