import "server-only";

import { z } from "zod";
import { paymentHoldDurationSeconds, type CheckoutLifecycle } from "@/lib/payments/domain";
import { activeOnlinePaymentProvider } from "@/lib/payments/settings";
import { readCurrentAccount } from "@/lib/auth/account";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localToday } from "@/lib/courts/local-time";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { createClient } from "@/lib/supabase/server";
import { readCreatedBookingCancellationPolicy, type ConfirmedCancellationPolicy } from "./confirmation-policy";
import { customerBookingInputSchema } from "./domain";

type Reader = Awaited<ReturnType<typeof createClient>>;
type Writer = ReturnType<typeof createBookingWriter>;
export type CustomerBookingResult = (CheckoutLifecycle & { ok: true; bookingId: string; reservationId: string; paymentAttemptId: string;
  totalAmountMinor: number; currency: LocationCurrency; cancellationPolicy: ConfirmedCancellationPolicy | null })
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
    expectedTotalAmountMinor, expectedCurrency, paymentMethod } = parsed.data;
  let locations;
  try { locations = await listPublicLocationsWithCourts(client); }
  catch { return { ok: false, message: "Unable to check court availability. Try again." }; }
  const location = locations.find((item) => item.courts.some((court) => court.id === courtId));
  if (!location) return { ok: false, message: "That court is not available for booking." };
  if (paymentMethod === "pay_at_club" && !location.allow_pay_at_club)
    return { ok: false, message: "Pay at club is not available at this location." };
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

  const bookingWriter = writer ?? createBookingWriter();
  const provider = paymentMethod === "online" ? await activeOnlinePaymentProvider(bookingWriter) : null;
  if (paymentMethod === "online" && !provider)
    return { ok: false, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." };
  const result = await bookingWriter.rpc("create_customer_booking", {
    p_court_id: courtId, p_booking_date: date, p_starts_at_minute: startMinute,
    p_ends_at_minute: endMinute, p_account_user_id: account.state === "active" ? account.userId : null,
    p_customer_name: customerName, p_customer_email: customerEmail, p_customer_phone: customerPhone,
    p_total_amount_minor: selection.priceMinor, p_currency: location.currency,
    p_payment_method: paymentMethod, p_provider: provider,
    p_hold_seconds: paymentHoldDurationSeconds,
  });
  if (result.error) {
    if (result.error.code === "P0001") return { ok: false, message: "Online payment availability changed. Please review your payment method and try again." };
    if (result.error.code === "23P01") return { ok: false, availabilityChanged: true,
      message: "That court is no longer available for the selected time." };
    logger.error({ event: "bookings.create_failed", courtId, code: result.error.code }, "Failed to create customer booking");
    return { ok: false, message: "Unable to create this booking. Try again." };
  }
  const ids = z.array(z.object({ booking_id: z.uuid(), reservation_id: z.uuid(), payment_attempt_id: z.uuid() }).and(
    z.discriminatedUnion("booking_status", [
      z.object({ booking_status: z.literal("pending_payment"), hold_expires_at: z.iso.datetime({ offset: true }) }),
      z.object({ booking_status: z.literal("confirmed"), hold_expires_at: z.null() }),
    ])))
    .length(1).safeParse(result.data);
  if (!ids.success) {
    logger.error({ event: "bookings.invalid_create_result", courtId }, "Invalid customer booking result");
    return { ok: false, message: "Unable to confirm this booking. Contact the club." };
  }
  const created = ids.data[0];
  const lifecycle: CheckoutLifecycle = created.booking_status === "pending_payment"
    ? { status: "pending_payment", holdExpiresAt: created.hold_expires_at }
    : { status: "confirmed", holdExpiresAt: null };
  const cancellationPolicy = lifecycle.status === "confirmed"
    ? await readCreatedBookingCancellationPolicy(ids.data[0].booking_id, bookingWriter) : null;
  if (cancellationPolicy && account.state === "active") {
    // Reuse PostgreSQL's timezone resolution from the existing owner-scoped read.
    try {
      const result = await client.rpc("list_own_upcoming_customer_bookings").eq("id", ids.data[0].booking_id);
      const parsed = z.array(z.object({ starts_at_instant: z.iso.datetime({ offset: true }) })).length(1).safeParse(result.data);
      if (result.error || !parsed.success) throw new Error("Start instant read failed");
      cancellationPolicy.cutoff = new Date(Date.parse(parsed.data[0].starts_at_instant) - cancellationPolicy.noticeMinutes * 60_000).toISOString();
    } catch {
      logger.error({ event: "bookings.confirmed_cutoff_read_failed", bookingId: ids.data[0].booking_id }, "Unable to read confirmed booking deadline");
    }
  }
  return { ok: true, ...lifecycle, bookingId: ids.data[0].booking_id, reservationId: ids.data[0].reservation_id, paymentAttemptId: created.payment_attempt_id,
    totalAmountMinor: selection.priceMinor, currency: location.currency, cancellationPolicy };
}
