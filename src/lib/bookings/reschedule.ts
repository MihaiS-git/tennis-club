import "server-only";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema, type OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { getDataSource } from "@/lib/db/data-source";
import { listCheckoutCourtCoverage, listCheckoutLocationCourts } from "@/lib/db/repositories/clubs.repository";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { courtSlotRates } from "@/lib/courts/calendar";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { readCurrentAccount } from "@/lib/auth/account";
import { bookingRescheduleInputSchema, readCustomerBookingEditContext, rescheduleCustomerBookingCommand } from "./commands";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { finishBookingAdjustment } from "@/lib/payments/booking-adjustments";
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
  if (!context) throw new Error("This booking is no longer available to edit.");
  const booking = bookingEditContextSchema.parse(context);
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.location_id,
    timezone: context.location_timezone, date: input.date, occupancy: context.occupancy, now,
    configuration: { location: booking.location, hours: context.hours } });
  // Every Edit opens a fresh form; earlier modifications are never resumed here.
  return { ...availability, day: await withCourtRates(availability.day, context.location_id, input.date,
    context.hours, booking.currency), booking };
}

// Display rates for the owner's timetable from the same configuration reads as the
// edit quote. The selected-interval quote remains the authoritative price.
async function withCourtRates<Day extends { times: number[]; courts: { court: { id: string } }[] }>(
  day: Day, locationId: string, date: string, hours: OpeningInterval[], currency: string) {
  const manager = (await getDataSource()).manager;
  const courts = await listCheckoutLocationCourts(manager, locationId);
  const weekday = mondayWeekday(date);
  return { ...day, currency, courts: await Promise.all(day.courts.map(async (row) => {
    const court = courts.find((item) => item.id === row.court.id);
    if (!court) return { ...row, rates: day.times.map(() => null) };
    const [coverage, rules] = await Promise.all([listCheckoutCourtCoverage(manager, court.id, date),
      listCheckoutPricing(manager, court.id, weekday, date)]);
    return { ...row, rates: courtSlotRates({ court, date, times: day.times, hours,
      coverage: coverage.map((c) => ({ id: c.id, court_id: c.courtId, starts_on: c.startsOn, ends_on: c.endsOn,
        created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString() })),
      pricing: rules.map((p) => ({ id: p.id, rule_set_id: p.ruleSetId, location_id: p.locationId, court_id: p.courtId,
        court_state: p.courtState, weekday: p.weekday, starts_at_minute: p.startsAtMinute, ends_at_minute: p.endsAtMinute,
        starts_on: p.startsOn, ends_on: p.endsOn, price_per_hour_minor: p.pricePerHourMinor,
        created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString() })) }).rates };
  })) };
}
export async function runBookingReschedule(input: unknown, actorId: string): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  try {
    return await finishBookingAdjustment(await rescheduleCustomerBookingCommand(parsed.data, actorId));
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")
      return { ok: false, message: "That court is no longer available. The booking has not changed." };
    logger.error({ event: "bookings.reschedule_failed", actorId, bookingId: parsed.data.id, code: failure.sqlState }, "Booking reschedule failed");
    return { ok: false, message: "Unable to reschedule this booking. Try again." };
  }
}
