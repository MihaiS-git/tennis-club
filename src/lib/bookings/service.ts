import "server-only";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import { checkoutPersistence, type CheckoutLifecycle } from "@/lib/payments/domain";
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
import { readCheckoutContext } from "./persistence";
import { bookingNotification } from "@/lib/notifications/booking-email";
import { customerMutationDeadline } from "./self-cancellation";

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
  const bookingWriter = writer ?? createBookingWriter();
  let context;
  try { context = await readCheckoutContext(courtId, date, startMinute, bookingWriter); }
  catch { return { ok: false, message: "That court is not available for booking." }; }
  if (!context) return { ok: false, message: "That court is not available for booking." };
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

  const provider = paymentMethod === "online" ? await activeOnlinePaymentProvider(bookingWriter) : null;
  if (paymentMethod === "online" && !provider)
    return { ok: false, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." };
  const bookingId = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
  const online = paymentMethod === "online";
  const event = online ? null : bookingNotification("confirmed", "confirmed", {
    booking_id: bookingId, customer_name: customerName, location_name: location.name, timezone: location.timezone,
    court_name: context.court.name, booking_date: date, starts_at_minute: startMinute, ends_at_minute: endMinute,
    total_amount_minor: selection.priceMinor, currency: location.currency, previous: null,
  }, customerEmail);
  const result = await bookingWriter.rpc("commit_checkout", {
    p_revision: context.revision, p_event: event,
    p_command: { booking_id: bookingId, reservation_id: reservationId, attempt_id: attemptId,
      court_id: courtId, date, start: startMinute, end: endMinute,
      account_user_id: account.state === "active" ? account.userId : null,
      customer_name: customerName, customer_email: customerEmail, customer_phone: customerPhone,
      amount: selection.priceMinor, currency: location.currency, method: paymentMethod, provider,
      cancellation_notice_minutes: context.location.customer_cancellation_notice_minutes,
      ...checkoutPersistence(paymentMethod) },
  });
  if (result.error) {
    if (result.error.code === "40001") return { ok: false, message: "Booking availability changed. Please review your selection and try again." };
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
    cancellationPolicy.cutoff = customerMutationDeadline({
      starts_at_instant: context.starts_at_instant,
      cancellation_notice_minutes: cancellationPolicy.noticeMinutes,
    }, false).deadline;
  }
  return { ok: true, ...lifecycle, bookingId: ids.data[0].booking_id, reservationId: ids.data[0].reservation_id, paymentAttemptId: created.payment_attempt_id,
    totalAmountMinor: selection.priceMinor, currency: location.currency, cancellationPolicy };
}
