import "server-only";

import { createHash } from "node:crypto";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import type { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
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
    const financial = await adjustments.bookingFinancials(manager, b.id, true);
    const payment = await payments.findAndLockEarliestSucceededStripeAttempt(manager, b.id);
    const existingRefund = await payments.findAndLockRefundByBooking(manager, b.id);
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active") return { outcome: scope === "owner" ? "inactive" : "unavailable", refund_id: null };
    if (scope === "admin" ? !actor.roles.includes("admin") : b.account_user_id !== actorId) return unavailable;
    // A cancelled booking without a refund is deliberately not a successful replay.
    if (b.status === "cancelled" && r.status === "cancelled") return existingRefund
      ? { outcome: "cancelled", refund_id: existingRefund.id,
          ...(financial.refunds.filter(r => r.operationKey === "cancellation").length > 1
            ? { refund_ids: financial.refunds.filter(r => r.operationKey === "cancellation").map(r => r.id) } : {}) } : unavailable;
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
    const pending = await adjustments.findPendingAdjustment(manager, b.id);
    if (pending) {
      await adjustments.updateAdjustment(manager, pending.id, "cancelled");
      await adjustments.releaseAdjustmentHolds(manager, pending.id);
    }
    const refundIds = refund ? await adjustments.allocateBookingRefund(manager, { bookingId: b.id,
      amount: financial.refundable, operationKey: "cancellation", actorId }) : [];
    const refundId = refundIds[0] ?? null;
    notification = event;
    return { outcome: "cancelled", refund_id: refundId, ...(refundIds.length > 1 ? { refund_ids: refundIds } : {}) };
  });
  if (notification) await sendBookingNotification(notification);
  return result;
}

export const bookingRescheduleInputSchema = z.strictObject({
  id: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
  expectedBookingUpdatedAt: z.iso.datetime({ offset: true }), courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  requestId: z.uuid().optional(), save: z.boolean(), expectedTotal: z.number().int().positive().nullable(), priceAcknowledged: z.boolean(),
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

async function executeReschedule(manager: EntityManager, a: Aggregate, edit: Edit, actorId: string, scope: Scope,
  notification: { value: BookingEmailEvent | null }, funded?: { id: string; adjustmentId: string }): Promise<BookingRescheduleResult> {
    if (edit.save && a.booking.payment_method === "pay_at_club")
      await payments.lockPayAtClubAmountDue(manager, a.booking.id);
    const lockedFinancials = edit.save && !funded && a.booking.payment_method === "online"
      ? await adjustments.bookingFinancials(manager,a.booking.id,true) : null;
    const requestKey = edit.requestId ?? createHash("sha256").update(JSON.stringify({ edit, actorId, scope })).digest("hex");
    const eligible = await editEligibility(manager, a, actorId, scope);
    if (!eligible.ok) return eligible;
    const b = a.booking, r = a.reservation;
    if (edit.save && !funded) {
      const previous = await adjustments.findAdjustmentRequest(manager, b.id, requestKey);
      const pending = previous ?? await adjustments.findUnresolvedAdjustment(manager, b.id);
      if (pending) {
        const attempt = await adjustments.adjustmentAttempt(manager,pending.id);
        return { ok: true, totalAmountMinor: pending.newTotal, adjustmentId: pending.id,
          adjustmentStatus: pending.status, target: pending.target,
          paymentRecoveryRequired: pending.status !== "pending" && !!attempt && !["succeeded","cancelled"].includes(attempt.status) };
      }
    }

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
    let adjustment: BookingAdjustmentEntity | null = null;
    let refundIds: string[] = [];
    if (total !== b.total_amount_minor && b.payment_method !== "pay_at_club") {
      if (b.payment_method !== "online") return { ok: false, message: "This historical booking has no verified payment method. Contact the club." };
      const delta = total - b.total_amount_minor;
      if (funded) {
        const attempt = await payments.lockCheckoutAttempt(manager, funded.id);
        if (!attempt || attempt.status !== "succeeded" || attempt.adjustmentId !== funded.adjustmentId
          || attempt.bookingId !== b.id || attempt.amountMinor !== delta || attempt.currency !== b.currency)
          return { ok: false, message: "The additional payment does not match this edit." };
      } else {
        const financial = lockedFinancials ?? await adjustments.bookingFinancials(manager, b.id, true);
        if (financial.payments.some(p => p.status === "pending" && p.adjustmentId)) return { ok: false,
          message: "A previous additional payment is still being verified. Reopen this booking to recover it; do not pay again yet." };
        if (financial.refundable !== b.total_amount_minor || financial.captures.some(p => p.currency !== b.currency)) return { ok: false,
          message: "This booking has an unresolved financial balance. Contact the club before changing its price." };
        const expiresAt = new Date(Date.parse(await reservations.readReservationClockTime(manager)) + paymentHoldDurationSeconds * 1000);
        adjustment = await adjustments.insertAdjustment(manager, { bookingId: b.id, actorId, scope, requestKey,
          target: { courtId: edit.courtId, date: edit.date, startMinute: edit.startMinute, endMinute: edit.endMinute,
            expectedUpdatedAt: edit.expectedUpdatedAt, expectedBookingUpdatedAt: edit.expectedBookingUpdatedAt, expectedTotal: total,
            original: { courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute,
              cancellationNoticeMinutes: b.cancellation_notice_minutes, refundDecision: true } },
          originalTotal: b.total_amount_minor, newTotal: total, currency: b.currency, expiresAt });
        if (delta > 0) {
          await adjustments.insertAdjustmentHolds(manager, adjustment, r);
          await adjustments.insertAdjustmentAttempt(manager, adjustment);
          return { ok: true, totalAmountMinor: total, adjustmentId: adjustment.id, adjustmentStatus: "pending", target: adjustment.target };
        }
        refundIds = await adjustments.allocateBookingRefund(manager, { bookingId: b.id, amount: -delta,
          operationKey: adjustment.id, adjustmentId: adjustment.id, actorId });
      }
    }
    const changed = r.court_id !== court.id || r.booking_date !== edit.date
      || r.starts_at_minute !== edit.startMinute || r.ends_at_minute !== edit.endMinute;
    const event = changed ? bookingNotification(scope === "owner" ? "customer_rescheduled" : "admin_rescheduled", {
        booking_id: b.id, customer_name: b.customer_name, location_name: a.location.name, timezone: a.location.timezone,
        court_name: court.name, booking_date: edit.date, starts_at_minute: edit.startMinute, ends_at_minute: edit.endMinute,
        total_amount_minor: total, currency: b.currency, previous: { court_name: a.resource.court_name,
          booking_date: r.booking_date, starts_at_minute: r.starts_at_minute, ends_at_minute: r.ends_at_minute },
      }, b.customer_email) : null;
    const now = await reservations.readReservationClockTime(manager);
    if (adjustment && timing(a, eligible.bypass, now) !== "eligible") throw new Error("Booking edit deadline crossed");
    if (timing(a, eligible.bypass, now) !== "eligible") return { ok: false,
      message: scope === "owner" ? "The rescheduling window for this booking has closed." : unavailableEdit.message };
    let writeDeadline: string | null = null;
    if (funded) {
      const paid = await adjustments.findAdjustment(manager, funded.adjustmentId);
      if (!paid || new Date(now) >= paid.expiresAt) return unavailableEdit;
      writeDeadline = paid.expiresAt.toISOString();
    }
    if (adjustment && (timing(a, eligible.bypass, now) !== "eligible" || microseconds(now) >= microseconds(targetStart)))
      throw new Error("Booking edit deadline crossed while preparing the refund");
    if (microseconds(now) >= microseconds(targetStart)) return unavailableEdit;
    const reservationWritten = await reservations.updateCustomerReservationSchedule(manager, r.id, edit, writeDeadline);
    if (funded && !reservationWritten) return unavailableEdit;
    const bookingWritten = await bookings.updateBookingRescheduleTotal(manager, b.id, total, writeDeadline);
    if (funded && !bookingWritten) throw new Error("Adjustment expired during the final booking write");
    if (b.payment_method === "pay_at_club") await payments.updatePayAtClubAmountDue(manager, b.id, total);
    notification.value = event;
    if (adjustment) await adjustments.updateAdjustment(manager, adjustment.id, "applied");
    return { ok: true, totalAmountMinor: total, ...(adjustment ? { adjustmentId: adjustment.id, adjustmentStatus: "applied" as const, refundIds, target: adjustment.target } : {}) };
}

export async function rescheduleCustomerBookingCommand(edit: Edit, actorId: string, scope: Scope): Promise<BookingRescheduleResult> {
  const notification: { value: BookingEmailEvent | null } = { value: null };
  const result = await withBooking<BookingRescheduleResult>(edit.id, true, scope === "owner"
    ? { ok: false, message: "This booking is no longer available to edit." } : unavailableEdit,
    (manager, a) => executeReschedule(manager, a, edit, actorId, scope, notification),
    { booking: edit.expectedBookingUpdatedAt, reservation: edit.expectedUpdatedAt });
  if (notification.value) await sendBookingNotification(notification.value);
  return result;
}

// Called only inside the verified provider settlement transaction, which already
// owns the configuration, location, booking, reservation and attempt locks.
export async function applyCapturedBookingAdjustment(manager: EntityManager, adjustment: BookingAdjustmentEntity, attemptId: string) {
  const booking = await bookings.findBookingForUpdate(manager, adjustment.bookingId, adjustment.target.expectedBookingUpdatedAt);
  const reservation = booking && await reservations.findReservationForUpdate(manager, booking.reservation_id, adjustment.target.expectedUpdatedAt);
  const resource = reservation && await reservations.findReservationResourceFacts(manager, reservation.court_id);
  const [location] = resource ? await clubs.lockLocations(manager, [resource.location_id]) : [];
  if (!booking || !reservation || !resource || !location) return { result: unavailableEdit, notification: null };
  const notification: { value: BookingEmailEvent | null } = { value: null };
  const result = await executeReschedule(manager, { booking, reservation, resource, location }, {
    ...adjustment.target, id: adjustment.bookingId, save: true, priceAcknowledged: true,
  }, adjustment.actorId, adjustment.scope, notification, { id: attemptId, adjustmentId: adjustment.id });
  return { result, notification: notification.value };
}
export async function readCustomerBookingEditContext(id: string, date: string, actorId: string, scope: Scope) {
  return withBooking(id, true, null, async (manager, a) => {
    const eligible = await editEligibility(manager, a, actorId, scope);
    if (!eligible.ok) throw new Error(eligible.message);
    const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
    const hours = await reservations.listReservationOpeningHours(manager, a.location.id, date);
    const occupancy = await reservations.listCustomerEditOccupancy(manager, a.location.id, date, a.reservation.id);
    const pendingAdjustment = await adjustments.findUnresolvedAdjustment(manager, a.booking.id);
    const financial = await adjustments.bookingFinancials(manager, a.booking.id);
    return { payment_method: a.booking.payment_method,
      financial: { captured: financial.captured, refunded: financial.refunded, refundObligations: financial.obligated,
        netPaid: financial.netPaid, outstanding: Math.max(0, a.booking.total_amount_minor - financial.netPaid) },
      refunds: financial.refunds.map(r => ({ id: r.id, amount: r.amountMinor, status: r.status })),
      pending_adjustment_id: pendingAdjustment?.id ?? null,
      adjustment_status: pendingAdjustment?.status,
      adjustment_total_minor: pendingAdjustment?.newTotal,
      adjustment_target: pendingAdjustment?.target,
      payment_recovery_required: pendingAdjustment?.status !== "pending" && !!pendingAdjustment,
      location_id: a.location.id, location_timezone: a.location.timezone, court_id: a.reservation.court_id,
      booking_date: a.reservation.booking_date, starts_at_minute: a.reservation.starts_at_minute,
      ends_at_minute: a.reservation.ends_at_minute, updated_at: a.reservation.updated_at,
      booking_updated_at: a.booking.updated_at, total_amount_minor: a.booking.total_amount_minor, currency: a.booking.currency,
      location: { id: a.location.id, name: a.location.name, timezone: a.location.timezone, is_active: a.location.isActive,
        archived_at: a.location.archivedAt?.toISOString() ?? null, courts: courts.map(c => ({ id: c.id, name: c.name, is_active: true })) },
      hours, occupancy };
  }, undefined, false);
}
