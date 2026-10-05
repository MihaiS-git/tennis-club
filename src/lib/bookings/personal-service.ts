import "server-only";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { minorAmountSchema } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import type { PersonalCustomerBooking } from "./personal";

const rowSchema = z.object({
  id: z.uuid(), starts_at_instant: z.iso.datetime({ offset: true }), booking_date: z.iso.date(), starts_at_minute: z.number().int(),
  ends_at_minute: z.number().int(), location_name: z.string(), location_timezone: z.string(),
  court_name: z.string(), customer_name: z.string(), customer_email: z.string(),
  customer_phone: z.string(), cancellation_notice_minutes: cancellationNoticeMinutesSchema, total_amount_minor: minorAmountSchema, currency: z.enum(locationCurrencies),
});

export async function listOwnUpcomingCustomerBookings(client?: Awaited<ReturnType<typeof createClient>>) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  const result = await supabase.rpc("list_own_upcoming_customer_bookings");
  const parsed = z.array(rowSchema).safeParse(result.data);
  if (result.error || !parsed.success) {
    logger.error({ event: "activity.bookings_read_failed", code: result.error?.code }, "Failed to load personal bookings");
    throw new Error("Unable to load your bookings.");
  }
  return parsed.data satisfies PersonalCustomerBooking[];
}
