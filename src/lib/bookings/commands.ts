import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { localStartInstant } from "@/lib/courts/local-time";
import { getCourtStateForDate } from "@/lib/courts/state";
import { mondayWeekday, resolvePricingRule } from "@/lib/pricing/resolution";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { fitsOpeningHours } from "@/lib/reservations/domain";
import { bookingNotification, sendBookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { customerBookingNoticeBypass, customerMutationDeadline } from "./self-cancellation";
import type { BookingRescheduleResult } from "./reschedule";

type Scope = "owner" | "admin";
type Booking = NonNullable<Awaited<ReturnType<typeof bookings.findBookingForUpdate>>>;
type Reservation = NonNullable<Awaited<ReturnType<typeof reservations.findReservationForUpdate>>>;
type Location = Awaited<ReturnType<typeof clubs.lockLocationsForRead>>[number];
type Resource = NonNullable<Awaited<ReturnType<typeof reservations.findReservationResourceFacts>>>;
type Aggregate = { booking: Booking; reservation: Reservation; location: Location; resource: Resource };
class BookingParentChanged extends Error {}

// The only retry is parent rediscovery, always in a fresh transaction. In
// particular serialization/deadlock failures never become browser stale results.
async function withBooking<T>(id: string, configuration: boolean, unavailable: T,
  work: (manager: EntityManager, aggregate: Aggregate) => Promise<T>,
  tokens?: { booking: string; reservation: string }, occupancyWrite = true): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await inTransaction(async (manager) => {
        if (configuration) await clubs.lockConfigurationForRead(manager);
        const parent = await bookings.discoverBookingLocation(manager, id);
        if (!parent) return unavailable;
        const [location] = await (occupancyWrite ? clubs.lockLocations : clubs.lockLocationsForRead)(manager, [parent.location_id]);
        if (!location) return unavailable;
        if (occupancyWrite && configuration) await expirePaymentHoldsAtLocation(manager, location.id);
        const booking = await bookings.findBookingForUpdate(manager, id, tokens?.booking);
        if (!booking) return unavailable;
        const reservation = await reservations.findReservationForUpdate(manager, booking.reservation_id, tokens?.reservation);
        if (!reservation) return unavailable;
        const resource = await reservations.findReservationResourceFacts(manager, reservation.court_id);
        if (!resource || resource.location_id !== parent.location_id) throw new BookingParentChanged();
        return work(manager, { booking, reservation, location, resource });
      });
    } catch (error: unknown) {
      if (!(error instanceof BookingParentChanged)) throw error;
    }
  }
  return unavailable;
}

// Date is used only to interpret the timezone-derived whole-minute deadline.
// Preserve the wall clock's sub-millisecond remainder for policy comparisons.
function microseconds(value: string): bigint {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}
function timing(aggregate: Aggregate, bypass: boolean, now: string): "eligible" | "started" | "notice_required" {
  const { booking: b, reservation: r, location: l } = aggregate;
  const start = localStartInstant(l.timezone, r.booking_date, r.starts_at_minute);
  if (microseconds(now) >= microseconds(start)) return "started";
  const deadline = customerMutationDeadline({ starts_at_instant: start, cancellation_notice_minutes: b.cancellation_notice_minutes }, bypass);
  return microseconds(now) > microseconds(deadline.deadline) ? "notice_required" : "eligible";
}
function activeOriginal(a: Aggregate) {
  return a.resource.court_active && a.location.isActive && a.location.archivedAt === null;
}

export async function cancelCustomerBookingCommand(id: string, actorId: string, scope: Scope, refundChoice: boolean | null) {
  const unavailable = { outcome: "unavailable", refund_id: null as string | null };
  let notification: BookingEmailEvent | null = null;
  const result = await withBooking(id, false, unavailable, async (manager, a) => {
    const b = a.booking, r = a.reservation;
    const payment = await payments.findAndLockEarliestSucceededStripeAttempt(manager, b.id);
    const existingRefund = await payments.findAndLockRefundByBooking(manager, b.id);
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active") return { outcome: scope === "owner" ? "inactive" : "unavailable", refund_id: null };
    if (scope === "admin" ? !actor.roles.includes("admin") : b.account_user_id !== actorId) return unavailable;
    // A cancelled booking without a refund is deliberately not a successful replay.
    if (b.status === "cancelled" && r.status === "cancelled") return existingRefund
      ? { outcome: "cancelled", refund_id: existingRefund.id } : unavailable;
    if (b.status !== "confirmed" || r.status !== "active" || scope === "admin" && !activeOriginal(a)) return unavailable;
    const bypass = scope === "admin" || customerBookingNoticeBypass(actor.roles);
    let checkedAt = await reservations.readReservationClockTime(manager);
    let eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: scope === "admin" ? "unavailable" : eligible, refund_id: null };
    if (scope === "admin" && payment && refundChoice === null) return { outcome: "refund_choice_required", refund_id: null };
    const refund = payment && (scope === "owner" || refundChoice === true) ? payment : null;
    const event = bookingNotification(scope === "owner" ? "customer_cancelled" : "admin_cancelled", {
      booking_id: b.id, customer_name: b.customer_name, location_name: a.location.name, timezone: a.location.timezone,
      court_name: a.resource.court_name, booking_date: r.booking_date, starts_at_minute: r.starts_at_minute,
      ends_at_minute: r.ends_at_minute, total_amount_minor: b.total_amount_minor, currency: b.currency, previous: null,
      ...(refund ? { refund_status: "requested" as const } : {}),
    }, b.customer_email);
    checkedAt = await reservations.readReservationClockTime(manager);
    eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: scope === "admin" ? "unavailable" : eligible, refund_id: null };
    await bookings.updateBookingCancellationStatus(manager, b.id);
    await reservations.updateCustomerReservationCancellation(manager, r.id, actorId, checkedAt);
    const refundId = refund ? await payments.insertBookingRefundRequest(manager, b.id, actorId, refund) : null;
    notification = event;
    return { outcome: "cancelled", refund_id: refundId };
  });
  if (notification) await sendBookingNotification(notification);
  return result;
}

export const bookingRescheduleInputSchema = z.strictObject({
  id: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
  expectedBookingUpdatedAt: z.iso.datetime({ offset: true }), courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  save: z.boolean(), expectedTotal: z.number().int().positive().nullable(), priceAcknowledged: z.boolean(),
}).refine(v => v.startMinute % 30 === 0 && v.endMinute % 30 === 0 && v.endMinute - v.startMinute >= 60);
type Edit = z.infer<typeof bookingRescheduleInputSchema>;
const unavailableEdit = { ok: false as const, message: "This booking or interval is no longer available to reschedule." };
const conflict = { ok: false as const, message: "That court is no longer available. The booking has not changed." };

async function editEligibility(manager: EntityManager, a: Aggregate, actorId: string, scope: Scope) {
  const actor = await lockReservationActorFacts(manager, actorId);
  if (actor?.status !== "active") return { ok: false as const, message: scope === "owner"
    ? "An active account is required to edit a booking." : unavailableEdit.message };
  if (scope === "admin" ? !actor.roles.includes("admin") : a.booking.account_user_id !== actorId)
    return { ok: false as const, message: scope === "owner" ? "This booking is no longer available to edit." : unavailableEdit.message };
  if (a.booking.status !== "confirmed" || a.reservation.status !== "active" || !activeOriginal(a)
    || a.location.currency !== a.booking.currency) return { ok: false as const,
      message: scope === "owner" ? "This booking is no longer available to edit." : unavailableEdit.message };
  const bypass = scope === "admin" || customerBookingNoticeBypass(actor.roles);
  if (timing(a, bypass, await reservations.readReservationClockTime(manager)) !== "eligible")
    return { ok: false as const, message: scope === "owner" ? "The rescheduling window for this booking has closed." : unavailableEdit.message };
  return { ok: true as const, bypass };
}

export async function rescheduleCustomerBookingCommand(edit: Edit, actorId: string, scope: Scope): Promise<BookingRescheduleResult> {
  let notification: BookingEmailEvent | null = null;
  const result = await withBooking<BookingRescheduleResult>(edit.id, true, scope === "owner"
    ? { ok: false, message: "This booking is no longer available to edit." } : unavailableEdit, async (manager, a) => {
    const eligible = await editEligibility(manager, a, actorId, scope);
    if (!eligible.ok) return eligible;
    const b = a.booking, r = a.reservation;
    if (!b.token_matches || !r.token_matches) return { ok: false, reason: "stale",
      message: "This booking has changed since you opened it. Close and reopen its details." };
    const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
    const court = courts.find(c => c.id === edit.courtId);
    const hours = await reservations.listReservationOpeningHours(manager, a.location.id, edit.date);
    if (!court || !fitsOpeningHours(hours, edit.date, edit.startMinute, edit.endMinute)) return unavailableEdit;
    const targetStart = localStartInstant(a.location.timezone, edit.date, edit.startMinute);
    if (microseconds(await reservations.readReservationClockTime(manager)) >= microseconds(targetStart)) return unavailableEdit;
    if (await hasOccupancyConflict(manager, edit, a.location.id, r.id)) return conflict;
    const coverage = await clubs.listCheckoutCourtCoverage(manager, court.id, edit.date);
    const state = getCourtStateForDate(court.environment, coverage.map(c => ({ starts_on: c.startsOn, ends_on: c.endsOn })), edit.date);
    const rules = await listCheckoutPricing(manager, court.id, mondayWeekday(edit.date), edit.date);
    const pricing = rules.map(p => ({ id: p.id, rule_set_id: p.ruleSetId, location_id: p.locationId,
      court_id: p.courtId, court_state: p.courtState, weekday: p.weekday, starts_at_minute: p.startsAtMinute,
      ends_at_minute: p.endsAtMinute, starts_on: p.startsOn, ends_on: p.endsOn, price_per_hour_minor: p.pricePerHourMinor,
      created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString() }));
    const times = Array.from({ length: (edit.endMinute - edit.startMinute) / 30 }, (_, i) => edit.startMinute + i * 30);
    const hourlyPrices = times.map(minute => {
      const rule = resolvePricingRule(pricing, { court_id: court.id, court_state: state, date: edit.date, minute });
      return rule && minute + 30 <= rule.ends_at_minute ? rule.price_per_hour_minor : null;
    });
    const selection = getCalendarSelection({ courtId: court.id, times, cells: times.map(() => "available"), hourlyPrices }, 0, times.length);
    if (!selection || selection.priceMinor > 2147483647) return { ok: false,
      message: "No complete pricing is available for this interval. Choose another interval." };
    const total = selection.priceMinor;
    if (!edit.save) return { ok: true, totalAmountMinor: total };
    if (edit.expectedTotal !== total || total !== b.total_amount_minor && !edit.priceAcknowledged)
      return { ok: false, reason: "price_changed", totalAmountMinor: total,
        message: "The price has changed. Confirm the new total before saving." };
    const changed = r.court_id !== court.id || r.booking_date !== edit.date
      || r.starts_at_minute !== edit.startMinute || r.ends_at_minute !== edit.endMinute;
    const event = changed ? bookingNotification(scope === "owner" ? "customer_rescheduled" : "admin_rescheduled", {
        booking_id: b.id, customer_name: b.customer_name, location_name: a.location.name, timezone: a.location.timezone,
        court_name: court.name, booking_date: edit.date, starts_at_minute: edit.startMinute, ends_at_minute: edit.endMinute,
        total_amount_minor: total, currency: b.currency, previous: { court_name: a.resource.court_name,
          booking_date: r.booking_date, starts_at_minute: r.starts_at_minute, ends_at_minute: r.ends_at_minute },
      }, b.customer_email) : null;
    const now = await reservations.readReservationClockTime(manager);
    if (timing(a, eligible.bypass, now) !== "eligible") return { ok: false,
      message: scope === "owner" ? "The rescheduling window for this booking has closed." : unavailableEdit.message };
    if (microseconds(now) >= microseconds(targetStart)) return unavailableEdit;
    await reservations.updateCustomerReservationSchedule(manager, r.id, edit);
    await bookings.updateBookingRescheduleTotal(manager, b.id, total);
    notification = event;
    return { ok: true, totalAmountMinor: total };
  }, { booking: edit.expectedBookingUpdatedAt, reservation: edit.expectedUpdatedAt });
  if (notification) await sendBookingNotification(notification);
  return result;
}

export async function readCustomerBookingEditContext(id: string, date: string, actorId: string, scope: Scope) {
  return withBooking(id, true, null, async (manager, a) => {
    const eligible = await editEligibility(manager, a, actorId, scope);
    if (!eligible.ok) throw new Error(eligible.message);
    const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
    const hours = await reservations.listReservationOpeningHours(manager, a.location.id, date);
    const occupancy = await reservations.listCustomerEditOccupancy(manager, a.location.id, date, a.reservation.id);
    return { location_id: a.location.id, location_timezone: a.location.timezone, court_id: a.reservation.court_id,
      booking_date: a.reservation.booking_date, starts_at_minute: a.reservation.starts_at_minute,
      ends_at_minute: a.reservation.ends_at_minute, updated_at: a.reservation.updated_at,
      booking_updated_at: a.booking.updated_at, total_amount_minor: a.booking.total_amount_minor, currency: a.booking.currency,
      location: { id: a.location.id, name: a.location.name, timezone: a.location.timezone, is_active: a.location.isActive,
        archived_at: a.location.archivedAt?.toISOString() ?? null, courts: courts.map(c => ({ id: c.id, name: c.name, is_active: true })) },
      hours, occupancy };
  }, undefined, false);
}
