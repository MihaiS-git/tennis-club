import "server-only";
import { randomUUID } from "node:crypto";

import { checkoutPersistence, type CheckoutLifecycle } from "@/lib/payments/domain";
import { configuredPaymentProvider, supportsOnlineCheckout } from "@/lib/payments/providers";
import { readCurrentAccount } from "@/lib/auth/account";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localMinute, localStartInstant } from "@/lib/courts/local-time";
import { buildCourtDay } from "@/lib/courts/calendar";
import { isPubliclyEligible, publicationToday } from "@/lib/locations/publication";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockCheckoutAccountStatus } from "@/lib/db/repositories/accounts.repository";
import { lockConfigurationForRead, lockLocations, findCourtConfiguration,
  listCheckoutLocationCourts, listLocationOpeningHours, listCheckoutCourtCoverage } from "@/lib/db/repositories/clubs.repository";
import { listLocationPublicationPricing, listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { readCheckoutClock, insertCustomerReservation } from "@/lib/db/repositories/reservations.repository";
import { readOccupancyForMutation } from "@/lib/reservations/occupancy";
import { insertCheckoutBooking } from "@/lib/db/repositories/bookings.repository";
import { findSelectedPaymentProvider, insertCheckoutAttempt } from "@/lib/db/repositories/payments.repository";
import { readCreatedBookingCancellationPolicy, type ConfirmedCancellationPolicy } from "./confirmation-policy";
import { customerBookingInputSchema } from "./domain";
import { bookingNotification, sendBookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { customerMutationDeadline } from "./self-cancellation";

class CheckoutParentChanged extends Error {}

type Reader = Awaited<ReturnType<typeof createClient>>;
export type CustomerBookingResult = (CheckoutLifecycle & { ok: true; bookingId: string; reservationId: string; paymentAttemptId: string;
  totalAmountMinor: number; currency: LocationCurrency; cancellationPolicy: ConfirmedCancellationPolicy | null })
  | { ok: false; reason: "price_changed"; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; message: string; availabilityChanged?: boolean };

export async function createCustomerBooking(input: unknown, reader?: Reader,
  now = new Date()): Promise<CustomerBookingResult> {
  const parsed = customerBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the booking details." };
  // Auth/network work is complete before the database transaction starts.
  const account = await readCurrentAccount(reader ?? await createClient());
  if (account.state !== "unauthenticated" && account.state !== "active")
    return { ok: false, message: "This account cannot create a booking." };
  const { courtId, date, startMinute, endMinute, customerName, customerEmail, customerPhone,
    expectedTotalAmountMinor, expectedCurrency, paymentMethod } = parsed.data;
  let notification: BookingEmailEvent | null = null;
  let failureMessage = "That court is not available for booking.";
  let created: CustomerBookingResult & { startsAtInstant?: string };
  for (let attempt = 0; ; attempt++) {
    try {
      created = await inTransaction(async (manager): Promise<CustomerBookingResult & { startsAtInstant?: string }> => {
        notification = null;
        await lockConfigurationForRead(manager);
        const parent = await findCourtConfiguration(manager, courtId);
        if (!parent) return { ok: false, message: "That court is not available for booking." };
        const [location] = await lockLocations(manager, [parent.locationId]);
        if (!location) return { ok: false, message: "That court is not available for booking." };
        failureMessage = "Unable to check court availability. Try again.";
        const authoritative = await findCourtConfiguration(manager, courtId);
        if (!authoritative || authoritative.locationId !== parent.locationId) throw new CheckoutParentChanged();
        const courts = await listCheckoutLocationCourts(manager, location.id);
        const hours = await listLocationOpeningHours(manager, location.id);
        const publicationPricing = await listLocationPublicationPricing(manager, location.id);
        const coverage = await listCheckoutCourtCoverage(manager, courtId, date);
        const pricing = await listCheckoutPricing(manager, courtId, mondayWeekday(date), date);
        const occupancy = await readOccupancyForMutation(manager, location.id, courtId, date);
        // The revision and location remain held throughout these reads and writes.
        if (account.state === "active") {
          const actor = await lockCheckoutAccountStatus(manager, account.userId);
          if (actor?.status !== "active") return { ok: false, message: "Unable to create this booking. Try again." };
        }
        const selectedProvider = paymentMethod === "online" ? await findSelectedPaymentProvider(manager, true) : null;
        const publicCourts = courts.map((court) => ({ id: court.id, name: court.name, slug: court.slug,
          surface: court.surface, environment: court.environment, has_lighting: court.hasLighting }));
        const today = publicationToday(location.timezone, now);
        if (!isPubliclyEligible({ name: location.name, slug: location.slug, timezone: location.timezone,
          currency: location.currency, is_active: location.isActive, is_public: location.isPublic,
          archived_at: location.archivedAt?.toISOString() ?? null, location_opening_hours: hours,
          courts: courts.map((court) => ({ id: court.id, environment: court.environment,
            location_pricing_rules: publicationPricing.filter((rule) => rule.courtId === court.id)
              .map((rule) => ({ court_state: rule.courtState, ends_on: rule.endsOn })) })),
        }, today) || !courts.some((court) => court.id === courtId))
          return { ok: false, message: "That court is not available for booking." };
        if (paymentMethod === "pay_at_club" && !location.allowPayAtClub)
          return { ok: false, message: "Pay at club is not available at this location." };
        if (date < today) return { ok: false, message: "Choose a future time at this location." };
        const day = buildCourtDay({ date, today, currentMinute: localMinute(location.timezone, now),
          courts: publicCourts.filter((court) => court.id === courtId),
          hours: hours.map((row) => ({ id: row.id, location_id: row.locationId, weekday: row.weekday,
            opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute,
            created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() })),
          coverage: coverage.map((row) => ({ id: row.id, court_id: row.courtId, starts_on: row.startsOn, ends_on: row.endsOn,
            created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() })),
          pricing: pricing.map((row) => ({ id: row.id, rule_set_id: row.ruleSetId, location_id: row.locationId,
            court_id: row.courtId, court_state: row.courtState, weekday: row.weekday, starts_at_minute: row.startsAtMinute,
            ends_at_minute: row.endsAtMinute, starts_on: row.startsOn, ends_on: row.endsOn, price_per_hour_minor: row.pricePerHourMinor,
            created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() })), reservations: occupancy });
        const court = day.courts[0];
        const selection = court && getCalendarSelection({ courtId, times: day.times, cells: court.cells,
          hourlyPrices: court.hourlyPrices }, day.times.indexOf(startMinute), day.times.indexOf(endMinute - 30) + 1);
        if (!selection || selection.endMinute !== endMinute) return { ok: false, availabilityChanged: true,
          message: "That court is no longer available for the selected time." };
        if (expectedTotalAmountMinor !== selection.priceMinor || expectedCurrency !== location.currency)
          return { ok: false, reason: "price_changed", totalAmountMinor: selection.priceMinor, currency: location.currency };
        const provider = configuredPaymentProvider(selectedProvider);
        if (paymentMethod === "online" && !supportsOnlineCheckout(provider)) return { ok: false,
          message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." };
        const lifecycle = checkoutPersistence(paymentMethod);
        const clock = await readCheckoutClock(manager, lifecycle.hold_seconds);
        const startsAtInstant = localStartInstant(location.timezone, date, startMinute);
        if (Date.parse(startsAtInstant) <= Date.parse(clock.now))
          return { ok: false, message: "Unable to create this booking. Try again." };
        const bookingId = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
        failureMessage = "Unable to create this booking. Try again.";
        await insertCustomerReservation(manager, { id: reservationId, courtId, date, startMinute, endMinute,
          status: lifecycle.reservation_status, holdExpiresAt: clock.expiry });
        await insertCheckoutBooking(manager, { id: bookingId, reservationId,
          accountUserId: account.state === "active" ? account.userId : null,
          customerName, customerEmail, customerPhone, status: lifecycle.booking_status,
          totalAmountMinor: selection.priceMinor, currency: location.currency,
          cancellationNoticeMinutes: location.customerCancellationNoticeMinutes, paymentMethod });
        await insertCheckoutAttempt(manager, { id: attemptId, bookingId, method: paymentMethod, provider,
          amountMinor: selection.priceMinor, currency: location.currency, status: lifecycle.attempt_status, expiresAt: clock.expiry });
        if (paymentMethod === "pay_at_club") notification = bookingNotification("confirmed", {
          booking_id: bookingId, customer_name: customerName, location_name: location.name, timezone: location.timezone,
          court_name: court.court.name, booking_date: date, starts_at_minute: startMinute, ends_at_minute: endMinute,
          total_amount_minor: selection.priceMinor, currency: location.currency, previous: null,
        }, customerEmail);
        if (paymentMethod === "online" && clock.expiry === null) throw new Error("Missing payment hold deadline.");
        return { ok: true, bookingId, reservationId, paymentAttemptId: attemptId,
          ...(clock.expiry === null ? { status: "confirmed", holdExpiresAt: null } as const
            : { status: "pending_payment", holdExpiresAt: clock.expiry } as const),
          totalAmountMinor: selection.priceMinor, currency: location.currency, cancellationPolicy: null, startsAtInstant };
      });
      break;
    } catch (error: unknown) {
      if (error instanceof CheckoutParentChanged && attempt < 2) continue;
      const failure = normalizeDatabaseError(error);
      if (error instanceof CheckoutParentChanged || failure.sqlState === "40001") return { ok: false, message: "Booking availability changed. Please review your selection and try again." };
      if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")
        return { ok: false, availabilityChanged: true, message: "That court is no longer available for the selected time." };
      logger.error({ event: "bookings.create_failed", courtId, code: failure.sqlState }, "Failed to create customer booking");
      return { ok: false, message: failureMessage };
    }
  }
  if (!created.ok) return created;
  if (notification) await sendBookingNotification(notification);
  const { startsAtInstant, ...result } = created;
  const cancellationPolicy = result.status === "confirmed" ? await readCreatedBookingCancellationPolicy(result.bookingId) : null;
  if (cancellationPolicy && account.state === "active" && startsAtInstant) {
    cancellationPolicy.cutoff = customerMutationDeadline({ starts_at_instant: startsAtInstant,
      cancellation_notice_minutes: cancellationPolicy.noticeMinutes }, false).deadline;
  }
  return { ...result, cancellationPolicy };
}
