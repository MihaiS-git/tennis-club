import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localToday } from "@/lib/courts/local-time";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { createClient } from "@/lib/supabase/server";
import { customerBookingInputSchema } from "./domain";

type Reader = Awaited<ReturnType<typeof createClient>>;
type Writer = ReturnType<typeof createBookingWriter>;
export type CustomerBookingResult = { ok: true; bookingId: string; reservationId: string;
  totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; reason: "price_changed"; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; message: string; availabilityChanged?: boolean };

export async function createCustomerBooking(input: unknown, reader?: Reader, writer?: Writer,
  now = new Date()): Promise<CustomerBookingResult> {
  const parsed = customerBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the booking details." };
  const client = reader ?? await createClient();
  const account = await readCurrentAccount(client);
  if (account.state !== "unauthenticated" && account.state !== "active")
    return { ok: false, message: "This account cannot create a booking." };

  const { courtId, date, startMinute, endMinute, customerName, customerEmail, customerPhone,
    expectedTotalAmountMinor, expectedCurrency } = parsed.data;
  let locations;
  try { locations = await listPublicLocationsWithCourts(client); }
  catch { return { ok: false, message: "Unable to check court availability. Try again." }; }
  const location = locations.find((item) => item.courts.some((court) => court.id === courtId));
  if (!location) return { ok: false, message: "That court is not available for booking." };
  const today = localToday(location.timezone, now);
  if (date < today) return { ok: false, message: "Choose a future time at this location." };

  let day;
  try { day = await getPublicCourtDay(location, date, today, now, client); }
  catch { return { ok: false, message: "Unable to check court availability. Try again." }; }
  const court = day.courts.find((item) => item.court.id === courtId);
  if (!court) return { ok: false, message: "That court is not available for booking." };
  const startRow = day.times.indexOf(startMinute);
  const endRow = day.times.indexOf(endMinute - 30) + 1;
  const selection = getCalendarSelection({ courtId, times: day.times, cells: court.cells,
    hourlyPrices: court.hourlyPrices }, startRow, endRow);
  if (!selection || selection.endMinute !== endMinute)
    return { ok: false, availabilityChanged: true, message: "That court is no longer available for the selected time." };

  if (expectedTotalAmountMinor !== selection.priceMinor || expectedCurrency !== location.currency)
    return { ok: false, reason: "price_changed", totalAmountMinor: selection.priceMinor, currency: location.currency };

  const result = await (writer ?? createBookingWriter()).rpc("create_customer_booking", {
    p_court_id: courtId, p_booking_date: date, p_starts_at_minute: startMinute,
    p_ends_at_minute: endMinute, p_account_user_id: account.state === "active" ? account.userId : null,
    p_customer_name: customerName, p_customer_email: customerEmail, p_customer_phone: customerPhone,
    p_total_amount_minor: selection.priceMinor, p_currency: location.currency,
  });
  if (result.error) {
    if (result.error.code === "23P01") return { ok: false, availabilityChanged: true,
      message: "That court is no longer available for the selected time." };
    logger.error({ event: "bookings.create_failed", courtId, code: result.error.code }, "Failed to create customer booking");
    return { ok: false, message: "Unable to create this booking. Try again." };
  }
  const ids = z.array(z.object({ booking_id: z.uuid(), reservation_id: z.uuid() }))
    .length(1).safeParse(result.data);
  if (!ids.success) {
    logger.error({ event: "bookings.invalid_create_result", courtId }, "Invalid customer booking result");
    return { ok: false, message: "Unable to confirm this booking. Contact the club." };
  }
  return { ok: true, bookingId: ids.data[0].booking_id, reservationId: ids.data[0].reservation_id,
    totalAmountMinor: selection.priceMinor, currency: location.currency };
}
