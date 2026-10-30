import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { requireActiveCoach } from "@/lib/coaching/authorization";
import { localStartInstant } from "@/lib/courts/local-time";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError, reservationOverlap } from "@/lib/db/errors";
import { inReadSnapshot } from "@/lib/db/transaction";
import { listBookingsWithLivePayment, listBookingsWithPendingChange } from "@/lib/db/repositories/booking-adjustments.repository";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { logger } from "@/lib/logger";
import { bookingFinancials } from "@/lib/payments/financials";
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { finishBookingCancellation, type BookingCancellationResult } from "@/lib/payments/refunds";
import { createClient } from "@/lib/supabase/server";
import type { BookingCancellationCommandResult } from "./domain";
import { cancelLessonAsCoachCommand } from "./cancellation-service";
import { BookingEditUnavailableError, bookingRescheduleInputSchema, readCoachLessonEditContext, rescheduleLessonAsCoachCommand } from "./commands";
import { projectBookingEditDay, type BookingRescheduleResult } from "./reschedule";
import { readBookingFilterLocations, readBookingListPage } from "./admin-details";
import { adminCancellationAvailability, type AdminCancellationAvailability } from "./admin-history";
import { parseCoachBookingQuery, type AdminBookingQuery, type BookingStatus } from "./admin-query";

type Client = Awaited<ReturnType<typeof createClient>>;

// The Coach List: the same server-side List query, scoped by the query itself to the
// Coach's own lessons and own staff reservations. Prices, payments and customer
// account IDs are dropped here so they never reach the browser.
export async function listCoachBookings(input: AdminBookingQuery, supabase?: Client, now = new Date()) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const result = await readBookingListPage(parseCoachBookingQuery({ ...input, page: String(input.page) }), actor.userId);
  // Every listed booking is one of the Coach's own lessons; the query enforces it.
  const lessons = result.rows.filter((row) => row.kind === "booking");
  let cancellations: Map<string, CoachLessonCancellation>;
  try {
    cancellations = await inReadSnapshot(manager => readLessonCancellations(manager, lessons, now));
  } catch (error: unknown) {
    logger.error({ event: "coach.bookings_list_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load lesson cancellation state");
    throw new Error("Unable to load bookings. Try again.");
  }
  return { ...result, rows: result.rows.map((row) => {
    if (row.kind === "reservation") return row;
    return { kind: row.kind, cancellation: cancellations.get(row.id)!, id: row.id, status: row.status, created_at: row.created_at, booking_date: row.booking_date,
      starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute, location_id: row.location_id,
      location_name: row.location_name, location_timezone: row.location_timezone, court_id: row.court_id, court_name: row.court_name,
      customer_name: row.customer_name, customer_email: row.customer_email, includes_coaching: row.includes_coaching,
      coach_name: row.coach_name, coaching_program_name: row.coaching_program_name };
  }) };
}
export type CoachBookingListItem = Awaited<ReturnType<typeof listCoachBookings>>["rows"][number];

// The assigned Coach's Cancel lesson state, shared by Lesson details, the Coach List and
// the Coach Calendar. It mirrors Admin Booking Details; the command still decides on submit.
export type CoachLessonCancellation = { availability: AdminCancellationAvailability; startsAt: string; refundAvailable: boolean };
// Callers authorize and scope the lessons to the Coach first.
export async function readLessonCancellations(manager: EntityManager, lessons: readonly { id: string; status: BookingStatus;
  booking_date: string; starts_at_minute: number; location_timezone: string }[], now: Date) {
  const ids = lessons.map((lesson) => lesson.id);
  const pendingChanges = await listBookingsWithPendingChange(manager, ids);
  const livePayments = await listBookingsWithLivePayment(manager, ids);
  const cancellations = new Map<string, CoachLessonCancellation>();
  for (const lesson of lessons) {
    const startsAt = localStartInstant(lesson.location_timezone, lesson.booking_date, lesson.starts_at_minute);
    const availability = adminCancellationAvailability({ status: lesson.status, startsAt, now,
      pendingChange: pendingChanges.get(lesson.id) ?? null, paymentPending: livePayments.has(lesson.id) });
    // As the command decides: only captured online funds are refundable. No amount is shown to the Coach.
    const refundAvailable = availability === "eligible" && (await bookingFinancials(manager, lesson.id)).refundable > 0;
    cancellations.set(lesson.id, { availability, startsAt, refundAvailable });
  }
  return cancellations;
}

export async function listCoachBookingFilterOptions(supabase?: Client) {
  await requireActiveCoach(supabase ?? await createClient());
  return readBookingFilterLocations();
}

// One of the Coach's own lessons, with the schedule and the customer contact the Coach
// Calendar already shows. Another Coach's lesson, a court booking and checkout state
// (payment pending, failed, expired) are indistinguishable from a missing booking.
// Cancellation availability mirrors Admin Booking Details; the command still decides.
export async function getCoachLesson(input: unknown, supabase?: Client, now = new Date()) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  let read: { booking: NonNullable<Awaited<ReturnType<typeof findAdminBookingDetails>>>; cancellation: CoachLessonCancellation } | null;
  try {
    await expirePaymentHolds();
    read = await inReadSnapshot(async manager => {
      const booking = await findAdminBookingDetails(manager, id.data);
      if (!booking || booking.coach_user_id !== actor.userId) return null;
      return { booking, cancellation: (await readLessonCancellations(manager, [booking], now)).get(booking.id)! };
    });
  } catch (error: unknown) {
    logger.error({ event: "coach.lesson_details_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load lesson details");
    throw new Error("Unable to load lesson details. Try again.");
  }
  const booking = read?.booking;
  if (!read || !booking || (booking.status !== "confirmed" && booking.status !== "cancelled")) return null;
  return { id: booking.id, status: booking.status, booking_date: booking.booking_date,
    starts_at_minute: booking.starts_at_minute, ends_at_minute: booking.ends_at_minute,
    location_name: booking.location_name, location_timezone: booking.location_timezone, court_name: booking.court_name,
    coach_name: booking.coach_name, coaching_program_name: booking.coaching_program_name,
    customer_name: booking.customer_name, customer_email: booking.customer_email, customer_phone: booking.customer_phone,
    created_at: booking.created_at,
    cancellation: read.cancellation };
}

// The assigned Coach cancels their own lesson through the Admin cancellation workflow:
// the command re-checks the active account, Coach role and assignment under lock.
export async function cancelAssignedLessonAsCoach(input: unknown, supabase?: Client): Promise<BookingCancellationResult> {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid lesson." };
  let data: BookingCancellationCommandResult;
  try {
    data = await cancelLessonAsCoachCommand(parsed.data.id, actor.userId);
  } catch {
    logger.error({ event: "bookings.coach_cancel_failed", actorId: actor.userId, bookingId: parsed.data.id }, "Failed to cancel lesson as Coach");
    return { ok: false, message: "Unable to cancel this lesson. Try again." };
  }
  const outcome = await finishBookingCancellation(data, "This lesson is no longer available to cancel.");
  if (outcome.ok) logger.info({ event: "bookings.coach_cancelled", actorId: actor.userId,
    bookingId: parsed.data.id, outcome: outcome.outcome }, "Coach lesson cancellation accepted");
  return outcome;
}

// The assigned Coach's Reschedule lesson timetable for one date: the lesson's fixed terms
// and the starts it can move to on its court, read under the booking locks after the
// Coach's account, role, assignment and the lesson's eligibility are rechecked.
// Prices and payments never reach the Coach: every amount is withheld as zero.
export async function getCoachLessonRescheduleDay(id: unknown, date: unknown, supabase?: Client, now = new Date()) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).safeParse({ id, date });
  if (!input.success) throw new BookingEditUnavailableError("Choose a valid lesson date.");
  const context = await readCoachLessonEditContext(input.data.id, input.data.date, actor.userId);
  if (!context) throw new BookingEditUnavailableError("This lesson is no longer available to reschedule.");
  const result = await projectBookingEditDay(context, input.data.date, now);
  const { booking } = result;
  return { ...result, day: { ...result.day, courts: result.day.courts.map((row) => ({ ...row, rates: row.rates.map(() => null) })) },
    booking: { ...booking, financial: undefined, refunds: [], total_amount_minor: 0,
      coaching: booking.coaching && { ...booking.coaching, coachingAmountMinor: 0,
        starts: booking.coaching.starts.map((start) => ({ ...start, courts: start.courts.map((court) => ({ ...court,
          coachingAmountMinor: 0, courtAmountMinor: 0, totalAmountMinor: 0 })) })) } } };
}

// The assigned Coach moves their own lesson. The command rechecks the account, Coach
// role, assignment, eligibility and availability under lock and keeps the agreed price,
// so the Coach's request carries no total and no payment is ever involved.
export async function rescheduleAssignedLessonAsCoach(input: unknown, supabase?: Client): Promise<BookingRescheduleResult> {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const parsed = bookingRescheduleInputSchema.safeParse(input && typeof input === "object"
    ? { ...input, expectedTotal: null, priceAcknowledged: false } : input);
  if (!parsed.success) return { ok: false, message: "Choose a valid lesson start." };
  let result: BookingRescheduleResult;
  try {
    result = await rescheduleLessonAsCoachCommand(parsed.data, actor.userId);
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    const overlap = reservationOverlap(failure);
    if (overlap === "court") return { ok: false, message: "That court is no longer available. The lesson has not changed." };
    if (overlap === "coach") return { ok: false, message: "You are no longer available at that time. The lesson has not changed." };
    logger.error({ event: "bookings.coach_reschedule_failed", actorId: actor.userId, bookingId: parsed.data.id,
      code: failure.sqlState }, "Failed to reschedule lesson as Coach");
    return { ok: false, message: "Unable to reschedule this lesson. Try again." };
  }
  if (!result.ok) return { ok: false, message: result.message, ...(result.reason === "stale" ? { reason: result.reason } : {}) };
  if (parsed.data.save) logger.info({ event: "bookings.coach_rescheduled", actorId: actor.userId, bookingId: parsed.data.id },
    "Coach lesson reschedule accepted");
  return { ok: true, totalAmountMinor: 0 };
}

// One of the Coach's own staff reservations. Actions mirror the existing owner
// commands, which still decide on submit: editable until it ends, and cancellable
// until it ends while its court and location are active.
export async function getCoachDirectReservation(input: unknown, supabase?: Client, now = new Date()) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  let row: Awaited<ReturnType<typeof reservations.findAdminDirectReservationDetails>>;
  try {
    row = await reservations.findAdminDirectReservationDetails((await getDataSource()).manager, id.data);
  } catch (error: unknown) {
    logger.error({ event: "coach.reservation_details_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation details");
    throw new Error("Unable to load reservation details. Try again.");
  }
  if (!row || row.created_by_user_id !== actor.userId) return null;
  const startsAt = localStartInstant(row.location_timezone, row.booking_date, row.starts_at_minute);
  const endsAt = localStartInstant(row.location_timezone, row.booking_date, row.ends_at_minute);
  const upcoming = row.status === "active" && Date.parse(endsAt) > now.getTime();
  return { reservation: row, startsAt, endsAt, started: Date.parse(startsAt) <= now.getTime(), editable: upcoming,
    cancellable: upcoming && row.court_active && row.location_active && row.archived_at === null };
}
