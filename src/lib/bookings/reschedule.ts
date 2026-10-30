import "server-only";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema, type OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { getDataSource } from "@/lib/db/data-source";
import { listBookingEditDayCoverage, listCheckoutLocationCourts } from "@/lib/db/repositories/clubs.repository";
import { listBookingEditDayPricing } from "@/lib/db/repositories/pricing.repository";
import { courtSlotRates } from "@/lib/courts/calendar";
import { createLocalIntervalValidator } from "@/lib/courts/local-time";
import { toCalendarCoveragePeriod, toCalendarPricingRule } from "@/lib/courts/calendar-projections";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { readCurrentAccount } from "@/lib/auth/account";
import { BookingEditUnavailableError, bookingRescheduleInputSchema, changeBookingOperationallyCommand, readCustomerBookingEditContext,
  rescheduleCustomerBookingCommand } from "./commands";
import { operationalChangeInputSchema, type OperationalCapacity } from "./operational-policy";
import { normalizeDatabaseError, reservationOverlap } from "@/lib/db/errors";
import { finishBookingAdjustment, finishOperationalChange } from "@/lib/payments/booking-adjustments";
import type { AdjustmentTarget } from "@/lib/db/entities/booking-adjustment.entity";
import type { OnlineCheckout } from "@/lib/payments/domain";
import type { RefundStatus } from "@/lib/payments/refunds";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;
const bookingEditContextSchema = z.object({
  payment_method: z.enum(["online", "pay_at_club"]),
  financial: z.object({ captured: z.number(), refunded: z.number(), refundObligations: z.number(), netPaid: z.number(), outstanding: z.number() }).optional(),
  refunds: z.array(z.object({ id: z.uuid(), amount: z.number(), status: z.enum(["pending", "pending_retry", "succeeded", "failed", "voided"]) })),
  location_id: z.uuid(), location_timezone: z.string(), court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  updated_at: z.iso.datetime({ offset: true }), current_revision_id: z.uuid(),
  total_amount_minor: z.number().int().positive(), currency: z.string(),
  location: reservationEditLocationSchema, hours: z.array(openingIntervalSchema),
  occupancy: z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() })),
  // A coaching lesson's immutable coach, program and duration, and the starts it can move to on the date.
  coaching: z.object({
    coach: z.object({ id: z.uuid(), name: z.string() }),
    program: z.object({ id: z.uuid(), name: z.string(), participantCount: z.number().int().positive(), courtRentalIncluded: z.boolean() }),
    durationMinutes: z.number().int(), coachingAmountMinor: z.number().int(),
    starts: z.array(z.object({ startMinute: z.number().int(), endMinute: z.number().int(), startsAt: z.string(), endsAt: z.string(),
      courts: z.array(z.object({ id: z.uuid(), name: z.string(), coachingAmountMinor: z.number().int(),
        courtAmountMinor: z.number().int(), totalAmountMinor: z.number().int() })) })),
  }).nullable(),
});
export type BookingEditContext = z.infer<typeof bookingEditContextSchema>;
export type BookingRescheduleResult = { ok: true; totalAmountMinor: number;
  adjustmentId?: string; adjustmentStatus?: "pending" | "applied" | "cancelled" | "expired" | "unsuccessful";
  target?: Pick<AdjustmentTarget,"courtId" | "date" | "startMinute" | "endMinute">; refundIds?: string[]; refundStatus?: RefundStatus; checkout?: OnlineCheckout; holdExpiresAt?: string }
  | { ok: false; message: string; reason?: "stale" | "price_changed"; totalAmountMinor?: number };

export async function loadBookingEditDay(id: unknown, date: unknown, client: Client, now = new Date()) {
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).parse({ id, date });
  const account = await readCurrentAccount(client);
  if (account.state !== "active")
    throw new Error("An active authorized account is required to edit a booking.");
  const context = await readCustomerBookingEditContext(input.id, input.date, account.userId);
  if (!context) throw new BookingEditUnavailableError("This booking is no longer available to edit.");
  return projectBookingEditDay(context, input.date, now);
}

// The edit timetable of one date from an authorized edit context, shared by owner and
// assigned-Coach rescheduling. Callers authorize and read the context under the booking locks.
export async function projectBookingEditDay(context: NonNullable<Awaited<ReturnType<typeof readCustomerBookingEditContext>>>,
  date: string, now: Date) {
  const booking = bookingEditContextSchema.parse(context);
  const availability = await loadReservationEditDayForLocation({ locationId: context.location_id,
    timezone: context.location_timezone, date, occupancy: context.occupancy, now,
    configuration: { location: booking.location, hours: context.hours } });
  const day = await withCourtRates(availability.day, context.location_id, date,
    context.hours, booking.currency, context.location.courts);
  // As on the public calendar, a slot whose local times do not exist or do not
  // elapse exactly as priced (DST transitions) cannot be selected.
  const validInterval = createLocalIntervalValidator(context.location_timezone, date);
  const validSlots = day.times.map((minute) => validInterval(minute, minute + 30));
  // Every Edit opens a fresh form; earlier modifications are never resumed here.
  return { ...availability, day: { ...day, courts: day.courts.map((row) => ({ ...row,
    cells: row.cells.map((cell, index) => cell === "available" && !validSlots[index] ? "closed" as const : cell) })) }, booking };
}

type RateCourt = Parameters<typeof courtSlotRates>[0]["court"];

// Display rates for the owner's timetable from the same configuration reads as the
// edit quote. The selected-interval quote remains the authoritative price.
export async function withCourtRates(
  day: Awaited<ReturnType<typeof loadReservationEditDayForLocation>>["day"],
  locationId: string, date: string, hours: OpeningInterval[], currency: string,
  loadedCourts?: readonly RateCourt[]) {
  const manager = (await getDataSource()).manager;
  const courts = loadedCourts ?? await listCheckoutLocationCourts(manager, locationId);
  const displayedIds = new Set(day.courts.map((row) => row.court.id));
  const byCourt = new Map<string, {
    court: (typeof courts)[number]; coverage: ReturnType<typeof toCalendarCoveragePeriod>[];
    pricing: ReturnType<typeof toCalendarPricingRule>[];
  }>(courts.filter((court) => displayedIds.has(court.id)).map((court) => [court.id, {
    court, coverage: [], pricing: [],
  }]));
  const weekday = mondayWeekday(date);
  const courtIds = [...byCourt.keys()];
  const [coverage, pricing] = await Promise.all([
    listBookingEditDayCoverage(manager, locationId, courtIds, date),
    listBookingEditDayPricing(manager, locationId, courtIds, weekday, date),
  ]);
  for (const row of coverage) byCourt.get(row.courtId)?.coverage.push(toCalendarCoveragePeriod(row));
  for (const row of pricing) byCourt.get(row.courtId)?.pricing.push(toCalendarPricingRule(row));
  return { ...day, currency, courts: day.courts.map((row) => {
    const configuration = byCourt.get(row.court.id);
    if (!configuration) return { ...row, rates: day.times.map(() => null) };
    return { ...row, rates: courtSlotRates({ ...configuration, date, times: day.times, hours }).rates };
  }) };
}
export async function runBookingReschedule(input: unknown, actorId: string): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  try {
    return await finishBookingAdjustment(await rescheduleCustomerBookingCommand(parsed.data, actorId));
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    const overlap = reservationOverlap(failure);
    if (overlap === "court") return { ok: false, message: "That court is no longer available. The booking has not changed." };
    if (overlap === "coach") return { ok: false, message: "The coach is no longer available at that time. The booking has not changed." };
    logger.error({ event: "bookings.reschedule_failed", actorId, bookingId: parsed.data.id, code: failure.sqlState }, "Booking reschedule failed");
    return { ok: false, message: "Unable to reschedule this booking. Try again." };
  }
}

// The shared staff operational change application workflow:
// validate, run the locked command, then process any refund after commit. The caller
// supplies the verified actor; the command re-authorizes the capacity under its locks.
export async function runOperationalBookingChange(input: unknown, actorId: string, capacity: OperationalCapacity) {
  const parsed = operationalChangeInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, reason: "invalid_target" as const };
  return finishOperationalChange(await changeBookingOperationallyCommand(parsed.data, actorId, capacity));
}
