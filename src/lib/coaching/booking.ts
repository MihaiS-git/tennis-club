import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";

import { locationCurrencies } from "@/lib/admin/locations-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { bookingContactShape } from "@/lib/bookings/domain";
import { buildBookingRevision } from "@/lib/bookings/revision";
import { findPublicLocationWithCourts } from "@/lib/courts/public";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockCheckoutAccountStatus, lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { findCourtConfiguration, lockConfigurationForRead, lockLocations } from "@/lib/db/repositories/clubs.repository";
import { lockCoachingProgramsForRead, lockCoachProfileForBooking } from "@/lib/db/repositories/coaching.repository";
import { insertCheckoutBooking } from "@/lib/db/repositories/bookings.repository";
import { findSelectedPaymentProvider, insertCheckoutAttempt } from "@/lib/db/repositories/payments.repository";
import { insertCustomerReservation, listExpiredCoachHoldCourts, readCheckoutClock } from "@/lib/db/repositories/reservations.repository";
import { inTransaction } from "@/lib/db/transaction";
import { logger } from "@/lib/logger";
import { checkoutPersistence } from "@/lib/payments/domain";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { configuredPaymentProvider, supportsOnlineCheckout } from "@/lib/payments/providers";
import { minorAmountSchema, type LocationCurrency } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { readCoachingLessonDay } from "./lesson-availability";
import { quoteCoachingLesson, type CoachingLessonUnavailableReason } from "./lesson-quote";

// One complete private or semi-private lesson: one coach, one payer, one court. The
// customer identity comes from the verified session, never from this input.
export const coachingBookingInputSchema = z.strictObject({
  locationId: z.uuid(),
  programId: z.uuid(),
  coachId: z.uuid(),
  courtId: z.uuid(),
  date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().min(60).max(1440),
  ...bookingContactShape,
  expectedTotalAmountMinor: minorAmountSchema,
  expectedCurrency: z.enum(locationCurrencies),
}).refine((value) => value.startMinute % 30 === 0 && value.durationMinutes % 30 === 0
  && value.startMinute + value.durationMinutes <= 1440,
{ path: ["startMinute"], message: "Choose at least 60 minutes in 30-minute steps." });

type CoachingBookingFailure = CoachingLessonUnavailableReason
  | "invalid-input" | "account-inactive" | "location-unavailable" | "past" | "payment-unavailable" | "changed" | "failed";

export type CoachingBookingResult =
  | { ok: true; bookingId: string; reservationId: string; paymentAttemptId: string; status: "pending_payment";
    holdExpiresAt: string; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; reason: "price_changed"; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; reason: CoachingBookingFailure; message: string; availabilityChanged?: boolean };

const messages: Record<CoachingBookingFailure, string> = {
  "invalid-input": "Check the booking details.",
  "account-inactive": "This account cannot create a booking.",
  "location-unavailable": "This location is not available for lessons.",
  "not-offered": "This coach does not offer this lesson here.",
  "invalid-duration": "This lesson length is not offered.",
  "invalid-time": "Choose a lesson start on a 30-minute boundary that fits the lesson length.",
  unpriced: "This lesson has no published price.",
  "coach-unavailable": "The coach is not available for the selected time.",
  "coach-booked": "The coach is no longer available for the selected time.",
  "court-unavailable": "That court is no longer available for the selected time.",
  past: "Choose a future time at this location.",
  "payment-unavailable": "Online payment is unavailable. Try again later.",
  changed: "Booking availability changed. Please review your selection and try again.",
  failed: "Unable to create this booking. Try again.",
};
const availabilityChanged = new Set<CoachingBookingFailure>(["coach-booked", "court-unavailable", "coach-unavailable"]);

function failure(reason: CoachingBookingFailure): CoachingBookingResult {
  return { ok: false, reason, message: messages[reason], ...availabilityChanged.has(reason) ? { availabilityChanged: true } : {} };
}

class CoachingParentChanged extends Error {}
type Intent = z.infer<typeof coachingBookingInputSchema>;

// Lock order: configuration share fence → coach profile FOR SHARE (the order of
// availability and assignment writes, which lock it FOR UPDATE) → ordered locations
// FOR UPDATE (the lesson's and those of the coach's expired holds) → program FOR SHARE
// → coach and customer account facts FOR SHARE. Coaching prices, court configuration
// and occupancy writers need these location locks, so every fact quoted below stays
// fixed until commit. No network request runs while the transaction is open.
async function reserveLesson(manager: EntityManager, intent: Intent, customerId: string | null, now: Date): Promise<CoachingBookingResult> {
  await lockConfigurationForRead(manager);
  if (!await lockCoachProfileForBooking(manager, intent.coachId)) return failure("not-offered");
  const court = await findCourtConfiguration(manager, intent.courtId);
  if (!court || court.locationId !== intent.locationId.toLowerCase()) return failure("court-unavailable");
  // Expired coach holds no longer occupy the coach for quoting, yet the coach
  // exclusion still covers them on any court or location until they are released.
  const discovered = await listExpiredCoachHoldCourts(manager, intent.coachId, intent.date);
  const locked = await lockLocations(manager, [court.locationId, ...discovered.map((row) => row.location_id)]);
  const location = locked.find((candidate) => candidate.id === court.locationId);
  if (!location) return failure("location-unavailable");
  if ((await findCourtConfiguration(manager, intent.courtId))?.locationId !== location.id) throw new CoachingParentChanged();
  const expired = await listExpiredCoachHoldCourts(manager, intent.coachId, intent.date);
  if (expired.some((row) => !locked.some((candidate) => candidate.id === row.location_id))) throw new CoachingParentChanged();
  // The existing hold expiry, under each location's lock: the lesson court, then the coach's expired holds.
  const courts = new Map([[court.id, location.id], ...expired.map((row) => [row.court_id, row.location_id] as const)]);
  for (const [courtId, locationId] of courts) await expirePaymentHoldsAtLocation(manager, locationId, { courtId });

  await lockCoachingProgramsForRead(manager, [intent.programId]);
  const coach = await lockReservationActorFacts(manager, intent.coachId);
  if (coach?.status !== "active" || !coach.roles.includes("coach")) return failure("not-offered");
  if (customerId && (await lockCheckoutAccountStatus(manager, customerId))?.status !== "active") return failure("account-inactive");
  const provider = configuredPaymentProvider(await findSelectedPaymentProvider(manager, true));
  if (!supportsOnlineCheckout(provider)) return failure("payment-unavailable");

  // Requote from facts read after the locks with the public availability rules.
  const publicLocation = await findPublicLocationWithCourts(manager, location.id, now);
  if (!publicLocation) return failure("location-unavailable");
  const day = await readCoachingLessonDay(manager, publicLocation, intent.coachId, intent.date, now);
  if (!day) throw new Error("Malformed lesson day.");
  if (intent.date < day.today) return failure("past");
  const quoted = quoteCoachingLesson(day, { programId: intent.programId, courtId: court.id,
    startMinute: intent.startMinute, durationMinutes: intent.durationMinutes });
  if (!quoted.ok) return failure(quoted.reason);
  const { quote } = quoted;
  if (quote.totalAmountMinor !== intent.expectedTotalAmountMinor || quote.currency !== intent.expectedCurrency)
    return { ok: false, reason: "price_changed", totalAmountMinor: quote.totalAmountMinor, currency: quote.currency };

  const lifecycle = checkoutPersistence("online");
  const clock = await readCheckoutClock(manager, lifecycle.hold_seconds);
  if (Date.parse(quote.startsAt) <= Date.parse(clock.now)) return failure("past");
  if (clock.expiry === null) throw new Error("Missing payment hold deadline.");
  const bookingId = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
  await insertCustomerReservation(manager, { id: reservationId, courtId: quote.court.id, date: quote.date,
    startMinute: quote.startMinute, endMinute: quote.endMinute, status: lifecycle.reservation_status,
    holdExpiresAt: clock.expiry, coachUserId: quote.coach.userId });
  // The agreed amounts and their evidence are the contract; later price changes never reprice it.
  const revision = buildBookingRevision({ locationId: location.id, courtId: quote.court.id, locationName: location.name,
    courtName: quote.court.name, timezone: location.timezone, bookingDate: quote.date, startMinute: quote.startMinute,
    endMinute: quote.endMinute, customerName: intent.customerName, customerEmail: intent.customerEmail,
    customerPhone: intent.customerPhone, totalAmountMinor: quote.totalAmountMinor, currency: quote.currency,
    paymentMethod: "online", cancellationNoticeMinutes: location.customerCancellationNoticeMinutes,
    pricingEvidence: { ...quote.evidence.courtPricing, coaching: { programId: quote.program.id, coachUserId: quote.coach.userId,
      locationId: quote.location.id, durationMinutes: quote.durationMinutes, source: quote.evidence.coachingPrice.source,
      amountMinor: quote.coachingAmountMinor, currency: quote.currency, courtRentalIncluded: quote.program.courtRentalIncluded,
      courtRentalMinor: quote.evidence.courtRentalMinor, courtAmountMinor: quote.courtAmountMinor,
      participantCount: quote.program.participantCount } },
    coachUserId: quote.coach.userId, coachingProgramId: quote.program.id, coachName: quote.coach.displayName,
    coachingProgramName: quote.program.name,
  }, { id: randomUUID(), bookingId, kind: "created", operationKey: "created", intentHash: "created",
    bookingState: lifecycle.booking_status, actorUserId: customerId, actorScope: customerId ? "customer" : "guest",
    recordedAt: new Date(clock.now), adjustmentId: null, cancellationCause: null }, null);
  await insertCheckoutBooking(manager, { id: bookingId, reservationId, accountUserId: customerId,
    status: lifecycle.booking_status, revision });
  await insertCheckoutAttempt(manager, { id: attemptId, bookingId, method: "online", provider,
    amountMinor: quote.totalAmountMinor, currency: quote.currency, status: lifecycle.attempt_status, expiresAt: clock.expiry });
  return { ok: true, bookingId, reservationId, paymentAttemptId: attemptId, status: "pending_payment",
    holdExpiresAt: clock.expiry, totalAmountMinor: quote.totalAmountMinor, currency: quote.currency };
}

type Reader = Awaited<ReturnType<typeof createClient>>;

// Creates one pending coaching booking, its revision, its held court-and-coach
// reservation and its pending online payment attempt atomically. The shared
// coaching checkout wrapper starts Stripe after this operation commits.
export async function createCoachingBooking(input: unknown, reader?: Reader, now = new Date()): Promise<CoachingBookingResult> {
  const parsed = coachingBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", message: parsed.error.issues[0]?.message ?? messages["invalid-input"] };
  // Auth/network work is complete before the database transaction starts.
  const account = await readCurrentAccount(reader ?? await createClient());
  if (account.state !== "unauthenticated" && account.state !== "active") return failure("account-inactive");
  const customerId = account.state === "active" ? account.userId : null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTransaction((manager) => reserveLesson(manager, parsed.data, customerId, now));
    } catch (error: unknown) {
      if (error instanceof CoachingParentChanged && attempt < 2) continue;
      const failed = normalizeDatabaseError(error);
      if (error instanceof CoachingParentChanged || failed.sqlState === "40001" || failed.sqlState === "40P01") return failure("changed");
      // Exclusions are the final arbiter of concurrent holds for the court and the coach.
      if (failed.sqlState === "23P01" && failed.constraint === "court_reservation_no_overlap") return failure("court-unavailable");
      if (failed.sqlState === "23P01" && failed.constraint === "court_reservation_coach_no_overlap") return failure("coach-booked");
      logger.error({ event: "coaching.booking_create_failed", code: failed.sqlState }, "Failed to create coaching booking");
      return failure("failed");
    }
  }
}
