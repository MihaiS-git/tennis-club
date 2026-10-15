import "server-only";

import { timestampToEpochMicroseconds } from "@/lib/precise-time";

import { adjustmentHoldFragments, refundBackedAdjustment, refundBackedOutcome, type BookingCancellationCommandResult } from "./domain";
import { buildBookingRevision, capturePricingEvidence, pricingEvidenceSchema, sameRevisionContract } from "./revision";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import * as revisions from "@/lib/db/repositories/booking-revisions.repository";
import { createHash, randomUUID } from "node:crypto";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import { bookingFinancials, allocateBookingRefund } from "@/lib/payments/financials";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { paymentHoldSeconds, type PaymentProvider } from "@/lib/payments/domain";
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
import { enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import { bookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
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

function timing(aggregate: Aggregate, bypass: boolean, now: string): "eligible" | "started" | "notice_required" {
  const { booking: b } = aggregate;
  const start = localStartInstant(b.revision.timezone, b.revision.bookingDate, b.revision.startMinute);
  if (timestampToEpochMicroseconds(now) >= timestampToEpochMicroseconds(start)) return "started";
  const deadline = customerMutationDeadline({ starts_at_instant: start, cancellation_notice_minutes: b.cancellation_notice_minutes }, bypass);
  return timestampToEpochMicroseconds(now) > timestampToEpochMicroseconds(deadline.deadline) ? "notice_required" : "eligible";
}
function activeOriginal(a: Aggregate) {
  return a.resource.court_active && a.location.isActive && a.location.archivedAt === null;
}

function actorScopeOf(roles: readonly string[]) {
  return roles.includes("admin") ? "admin_owner" as const : roles.includes("coach") ? "coach_owner" as const : "customer" as const;
}

// An open payment-backed proposal without a live payment is discarded; a live
// payment or any refund-backed change keeps the booking locked until it resolves.
async function blockingPendingChange(manager: EntityManager, bookingId: string) {
  const pending = await adjustments.findPendingAdjustment(manager, bookingId);
  if (!pending) return { blocking: null, discarded: null };
  if (refundBackedAdjustment(pending) || await adjustments.hasLivePayment(manager, pending.id))
    return { blocking: pending, discarded: null };
  return { blocking: null, discarded: pending };
}

export async function cancelCustomerBookingCommand(id: string, actorId: string, scope: Scope): Promise<BookingCancellationCommandResult> {
  const unavailable: BookingCancellationCommandResult = { outcome: "unavailable" };
  let notification: BookingEmailEvent | null = null;
  const result = await withBooking<BookingCancellationCommandResult>(id, false, unavailable, async (manager, a) => {
    notification = null;
    const b = a.booking, r = a.reservation;
    const financial = await bookingFinancials(manager, b.id, true);
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active") return { outcome: scope === "owner" ? "inactive" : "unavailable" };
    if (scope === "admin" ? !actor.roles.includes("admin") : b.account_user_id !== actorId) return unavailable;
    if (b.status === "cancelled" && b.revision.kind === "cancelled") {
      // Booking-management cancellation has one full-refund intent. A checkout
      // capability cancellation is a different operation, even for its owner.
      if (b.revision.operationKey !== "cancellation" || b.revision.intentHash !== "cancellation") return unavailable;
      const refunds = financial.refunds.filter(r => b.revision.adjustmentId
        ? r.adjustmentId === b.revision.adjustmentId : r.operationKey === "cancellation").map(r => r.id);
      return { outcome: "cancelled", refundIds: refunds };
    }
    const open = await blockingPendingChange(manager, b.id);
    // Repeating an accepted request reports it; it never allocates another refund.
    if (open.blocking?.kind === "cancellation") return { outcome: "cancellation_pending", adjustmentId: open.blocking.id,
      refundIds: financial.refunds.filter(r => r.adjustmentId === open.blocking?.id).map(r => r.id) };
    if (open.blocking) return { outcome: "change_pending" };
    if (b.status !== "confirmed" || r.status !== "active" || scope === "admin" && !activeOriginal(a)) return unavailable;
    const bypass = scope === "admin" || customerBookingNoticeBypass(actor.roles);
    let checkedAt = await reservations.readReservationClockTime(manager);
    let eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: scope === "admin" ? "unavailable" : eligible };
    const refund = b.payment_method === "online" && financial.refundable > 0;
    checkedAt = await reservations.readReservationClockTime(manager);
    eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: scope === "admin" ? "unavailable" : eligible };
    if (open.discarded) {
      await adjustments.updateAdjustment(manager, open.discarded.id, "cancelled");
      await adjustments.releaseAdjustmentHolds(manager, open.discarded.id);
    }
    const actorScope = scope === "admin" ? "admin" as const : actorScopeOf(actor.roles);
    if (refund) {
      // Eligibility is decided now and preserved by the request; the booking,
      // occupancy and contract stay unchanged until verified refund completion.
      const request = await adjustments.insertAdjustment(manager, { bookingId: b.id, baseRevisionId: b.current_revision_id,
        actorId, scope, kind: "cancellation", requestKey: `cancellation:${randomUUID()}`,
        target: { courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute,
          expectedUpdatedAt: r.updated_at, courtName: b.revision.courtName, locationName: b.revision.locationName,
          timezone: b.revision.timezone, actorScope },
        originalTotal: b.total_amount_minor, newTotal: b.total_amount_minor, currency: b.currency,
        expiresAt: new Date(checkedAt), createdAt: new Date(checkedAt) });
      const refundIds = await allocateBookingRefund(manager, { bookingId: b.id, amount: financial.refundable,
        operationKey: request.id, adjustmentId: request.id, actorId, reason: "booking_cancellation",
        contextRevisionId: b.current_revision_id });
      return { outcome: "cancellation_pending", adjustmentId: request.id, refundIds };
    }
    const revision = buildBookingRevision(b.revision, { id: randomUUID(), bookingId: b.id,
      kind: "cancelled", bookingState: "cancelled", operationKey: "cancellation", intentHash: "cancellation",
      actorUserId: actorId, actorScope, recordedAt: new Date(checkedAt), adjustmentId: null,
      cancellationCause: scope === "admin" ? "admin_cancelled" : "owner_cancelled" }, b.revision);
    await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "cancelled" });
    await reservations.updateCustomerReservationCancellation(manager, r.id, actorId, checkedAt);
    notification = bookingNotification(scope === "owner" ? "customer_cancelled" : "admin_cancelled", revision);
    await enqueueBookingNotification(manager, `revision:${revision.id}`, notification);
    return { outcome: "cancelled", refundIds: [] };
  });
  return result;
}

// Decides a refund-backed change (cancellation or price reduction) exactly once,
// only after every refund obligation has succeeded. Called after refund commits and by
// the recovery worker; the pending -> applied/unsuccessful transition under the
// booking lock makes replays no-ops and guards the single notification.
export async function resolveRefundBackedAdjustment(adjustmentId: string): Promise<BookingAdjustmentEntity["status"] | null> {
  const found = await adjustments.findAdjustment((await getDataSource()).manager, adjustmentId);
  if (!found || found.status !== "pending" || !refundBackedAdjustment(found)) return found?.status ?? null;
  let notification: BookingEmailEvent | null = null;
  const status = await withBooking<BookingAdjustmentEntity["status"] | null>(found.bookingId, true, null, async (manager, a) => {
    notification = null;
    const adjustment = await adjustments.findAdjustment(manager, adjustmentId);
    if (!adjustment || adjustment.bookingId !== a.booking.id) return null;
    if (adjustment.status !== "pending") return adjustment.status;
    const { refunds } = await payments.loadBookingFinancialFacts(manager, a.booking.id, true);
    const own = refunds.filter(refund => refund.adjustmentId === adjustment.id);
    const outcome = refundBackedOutcome(own.map(refund => refund.status));
    if (outcome === "waiting") {
      for (const refund of own.filter(refund => refund.status === "failed")) {
        await enqueueBookingNotification(manager, `refund:${refund.id}:exception`,
          bookingNotification("refund_incomplete", a.booking.revision,
            { refund: { amountMinor: refund.amountMinor, currency: refund.currency } }));
      }
      if (own.some(refund => refund.status === "failed")) {
        logger.error({ event: "bookings.refund_obligation_unresolved", adjustmentId }, "Booking preserved pending external refund resolution");
      }
      return "pending";
    }
    if (outcome === "abandon") {
      // No money moved: void the obligations so they no longer reserve captured
      // funds, keep the booking unchanged and let the customer request again.
      for (const refund of own) await payments.writeRefundStatus(manager, refund.id, "voided");
      await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
      await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
      notification = bookingNotification(adjustment.kind === "cancellation" ? "cancellation_failed" : "modification_failed",
        a.booking.revision);
      await enqueueBookingNotification(manager, `adjustment:${adjustment.id}:abandoned`, notification);
      return "unsuccessful";
    }
    const b = a.booking, r = a.reservation;
    const now = await reservations.readReservationClockTime(manager);
    const refundStatus = "completed" as const;
    if (b.current_revision_id !== adjustment.baseRevisionId)
      throw new revisions.BookingRevisionFenceError("Booking changed while a refund-backed change was pending");
    const actorScope = adjustment.target.actorScope ?? (adjustment.scope === "admin" ? "admin" : "customer");
    if (adjustment.kind === "cancellation") {
      if (b.status !== "confirmed" || r.status !== "active") throw new Error("Pending cancellation lost its booking state");
      const revision = buildBookingRevision(b.revision, { id: randomUUID(), bookingId: b.id,
        kind: "cancelled", bookingState: "cancelled", operationKey: "cancellation", intentHash: "cancellation",
        actorUserId: adjustment.actorId, actorScope, recordedAt: new Date(now), adjustmentId: adjustment.id,
        cancellationCause: adjustment.scope === "admin" ? "admin_cancelled" : "owner_cancelled" }, b.revision);
      await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "cancelled" });
      await reservations.updateCustomerReservationCancellation(manager, r.id, adjustment.actorId, now);
      await adjustments.updateAdjustment(manager, adjustment.id, "applied");
      notification = bookingNotification(adjustment.scope === "admin" ? "admin_cancelled" : "customer_cancelled", revision,
        { refundStatus });
      await enqueueBookingNotification(manager, `revision:${revision.id}`, notification);
      return "applied";
    }
    // Reduction: the accepted quote is applied as refunded, never repriced. Its
    // target fragments stayed held, so the original row can move onto them.
    const target = adjustment.target;
    await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
    await manager.query("SAVEPOINT refund_adjustment_apply");
    let moved = false;
    try { moved = await reservations.updateCustomerReservationSchedule(manager, r.id, target); }
    catch (error) {
      const failure = normalizeDatabaseError(error);
      if (!(failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")) throw error;
      await manager.query("ROLLBACK TO SAVEPOINT refund_adjustment_apply");
    }
    await manager.query("RELEASE SAVEPOINT refund_adjustment_apply");
    if (!moved) {
      // Unavoidable exception: the refund already left; the original booking stays.
      logger.error({ event: "bookings.refunded_change_unapplied", adjustmentId: adjustment.id, bookingId: b.id },
        "Refund completed but the booking change could not be applied");
      await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
      notification = bookingNotification("modification_failed", b.revision);
      await enqueueBookingNotification(manager, `adjustment:${adjustment.id}:unapplied`, notification);
      return "unsuccessful";
    }
    const terms = { ...b.revision, courtId: target.courtId, courtName: target.courtName, locationName: target.locationName,
      timezone: target.timezone, bookingDate: target.date, startMinute: target.startMinute, endMinute: target.endMinute,
      totalAmountMinor: adjustment.newTotal, pricingEvidence: pricingEvidenceSchema.parse(target.pricingEvidence) };
    const revision = buildBookingRevision(terms, { id: randomUUID(), bookingId: b.id, kind: "rescheduled", bookingState: "confirmed",
      operationKey: adjustment.requestKey, intentHash: createHash("sha256").update(adjustment.id).digest("hex"),
      actorUserId: adjustment.actorId, actorScope, recordedAt: new Date(now), adjustmentId: adjustment.id,
      cancellationCause: null }, b.revision);
    await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "confirmed" });
    await adjustments.updateAdjustment(manager, adjustment.id, "applied");
    notification = bookingNotification("customer_rescheduled", revision, { previous: b.revision, refundStatus });
    await enqueueBookingNotification(manager, `revision:${revision.id}`, notification);
    return "applied";
  });
  return status;
}

export const bookingRescheduleInputSchema = z.strictObject({
  id: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
  expectedRevisionId: z.uuid(), courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  requestId: z.uuid().optional(), save: z.boolean(), expectedTotal: z.number().int().positive().nullable(), priceAcknowledged: z.boolean(),
}).refine(v => v.startMinute % 30 === 0 && v.endMinute % 30 === 0 && v.endMinute - v.startMinute >= 60);
type Edit = z.infer<typeof bookingRescheduleInputSchema>;
const unavailableEdit = { ok: false as const, message: "This booking or interval is no longer available to reschedule." };
const conflict = { ok: false as const, message: "That court is no longer available. The booking has not changed." };

async function editEligibility(manager: EntityManager, a: Aggregate, actorId: string) {
  const actor = await lockReservationActorFacts(manager, actorId);
  if (actor?.status !== "active") return { ok: false as const, message: "An active account is required to edit a booking." };
  if (a.booking.account_user_id !== actorId)
    return { ok: false as const, message: "This booking is no longer available to edit." };
  if (a.booking.status !== "confirmed" || a.reservation.status !== "active" || !activeOriginal(a)
    || a.location.currency !== a.booking.currency) return { ok: false as const,
      message: "This booking is no longer available to edit." };
  const bypass = customerBookingNoticeBypass(actor.roles);
  if (timing(a, bypass, await reservations.readReservationClockTime(manager)) !== "eligible")
    return { ok: false as const, message: "The rescheduling window for this booking has closed." };
  return { ok: true as const, bypass, actorScope: actor.roles.includes("admin") ? "admin_owner" as const
    : actor.roles.includes("coach") ? "coach_owner" as const : "customer" as const };
}

async function executeReschedule(manager: EntityManager, a: Aggregate, edit: Edit, actorId: string,
  notification: { value: BookingEmailEvent | null }, funded?: { id: string; adjustment: BookingAdjustmentEntity },
  superseded?: SupersededAttempt[]): Promise<BookingRescheduleResult> {
    const lockedFinancials = edit.save && !funded && a.booking.payment_method === "online"
      ? await bookingFinancials(manager,a.booking.id,true) : null;
    const intentHash = createHash("sha256").update(JSON.stringify({ actorId, base: edit.expectedRevisionId,
      courtId: edit.courtId, date: edit.date, start: edit.startMinute, end: edit.endMinute, total: edit.expectedTotal })).digest("hex");
    const requestKey = edit.requestId ?? intentHash;
    const eligible = await editEligibility(manager, a, actorId);
    if (!eligible.ok) return eligible;
    const b = a.booking, r = a.reservation;
    if (edit.save && !funded) {
      const applied = await revisions.findRevisionOperation(manager, b.id, requestKey);
      if (applied) return applied.intentHash === intentHash ? { ok: true, totalAmountMinor: applied.totalAmountMinor }
        : { ok: false, message: "This operation key was already used for different booking details." };
      // Only an exact replay of the same request returns an existing modification.
      const previous = await adjustments.findAdjustmentRequest(manager, b.id, requestKey);
      if (previous) {
        if (previous.actorId !== actorId || previous.baseRevisionId !== edit.expectedRevisionId
          || previous.target.courtId !== edit.courtId || previous.target.date !== edit.date
          || previous.target.startMinute !== edit.startMinute || previous.target.endMinute !== edit.endMinute
          || previous.newTotal !== edit.expectedTotal) return { ok: false, message: "This operation key was already used for different booking details." };
        return { ok: true, totalAmountMinor: previous.newTotal, adjustmentId: previous.id,
          adjustmentStatus: previous.status, target: previous.target };
      }
      // A new request always starts fresh. A processing payment blocks it; an
      // unpaid earlier proposal is discarded and its provider payment resolved after commit.
      const open = await adjustments.findPendingAdjustment(manager, b.id);
      if (open) {
        if (open.kind === "cancellation") return { ok: false,
          message: "A cancellation request for this booking is being processed. The booking has not changed." };
        if (refundBackedAdjustment(open)) return { ok: false,
          message: "A previous change to this booking is waiting for its refund. The booking has not changed." };
        if (await adjustments.hasLivePayment(manager, open.id)) return { ok: false,
          message: "A previous additional payment is still processing. The booking has not changed." };
        await adjustments.updateAdjustment(manager, open.id, "cancelled");
        await adjustments.releaseAdjustmentHolds(manager, open.id);
        const attempt = await adjustments.adjustmentAttempt(manager, open.id);
        const locked = attempt && await payments.lockCheckoutAttempt(manager, attempt.id);
        if (locked?.status === "pending" && locked.provider) {
          // One pending attempt per booking: close it like the cutoff sweep does.
          // A later capture is still recorded and refunded, never applied.
          await payments.revokeCheckoutCapability(manager, locked.id);
          await payments.expirePendingAttempt(manager, locked.id);
          if (locked.providerPaymentId) superseded?.push({ id: locked.id, provider: locked.provider, providerPaymentId: locked.providerPaymentId });
        }
      }
    }

    if (!b.token_matches || !r.token_matches) return { ok: false, reason: "stale",
      message: "This booking has changed since you opened it. Close and reopen its details." };
    const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
    const court = courts.find(c => c.id === edit.courtId);
    const hours = await reservations.listReservationOpeningHours(manager, a.location.id, edit.date);
    if (!court || !fitsOpeningHours(hours, edit.date, edit.startMinute, edit.endMinute)) return unavailableEdit;
    const targetStart = localStartInstant(a.location.timezone, edit.date, edit.startMinute);
    if (timestampToEpochMicroseconds(await reservations.readReservationClockTime(manager)) >= timestampToEpochMicroseconds(targetStart)) return unavailableEdit;
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
    const terms = { ...b.revision, courtId: court.id, courtName: court.name,
      locationName: a.location.name, timezone: a.location.timezone, bookingDate: edit.date,
      startMinute: edit.startMinute, endMinute: edit.endMinute, totalAmountMinor: total,
      pricingEvidence: capturePricingEvidence(pricing, { courtId: court.id, courtState: state, date: edit.date,
        startMinute: edit.startMinute, endMinute: edit.endMinute, total }) };
    if (sameRevisionContract(b.revision, terms)) return { ok: true, totalAmountMinor: total };
    const revisionId = randomUUID();
    if (total !== b.total_amount_minor && b.payment_method !== "pay_at_club") {
      const delta = total - b.total_amount_minor;
      if (funded) {
        const attempt = await payments.lockCheckoutAttempt(manager, funded.id);
        if (!attempt || attempt.status !== "succeeded" || attempt.adjustmentId !== funded.adjustment.id
          || attempt.bookingId !== b.id || attempt.amountMinor !== delta || attempt.currency !== b.currency)
          return { ok: false, message: "The additional payment does not match this edit." };
      } else {
        // Pending attempts of discarded proposals are refunded if they ever capture.
        const financial = lockedFinancials ?? await bookingFinancials(manager, b.id, true);
        if (financial.refundable !== b.total_amount_minor || financial.captures.some(p => p.currency !== b.currency)) return { ok: false,
          message: "This booking has an unresolved financial balance. Contact the club before changing its price." };
        const fragments = adjustmentHoldFragments({ courtId:r.court_id,date:r.booking_date,startMinute:r.starts_at_minute,endMinute:r.ends_at_minute }, edit);
        const target = { courtId: edit.courtId, date: edit.date, startMinute: edit.startMinute, endMinute: edit.endMinute,
          expectedUpdatedAt: edit.expectedUpdatedAt, courtName: court.name, locationName: a.location.name, timezone: a.location.timezone,
          actorScope: eligible.actorScope };
        if (delta < 0) {
          // A reduction keeps the original booking until its refund is verified.
          // The accepted quote and its evidence are snapshotted; the target stays
          // held (bounded by its start) so the change can always be applied.
          const requestedAt = await reservations.readReservationClockTime(manager);
          if (timing(a, eligible.bypass, requestedAt) !== "eligible"
            || timestampToEpochMicroseconds(requestedAt) >= timestampToEpochMicroseconds(targetStart))
            return { ok: false, message: "The rescheduling window for this booking has closed." };
          const pending = await adjustments.insertAdjustment(manager, { bookingId: b.id, baseRevisionId: b.current_revision_id,
            actorId, scope: "owner", requestKey, target: { ...target, pricingEvidence: terms.pricingEvidence },
            originalTotal: b.total_amount_minor, newTotal: total, currency: b.currency, expiresAt: new Date(targetStart),
            createdAt: new Date(requestedAt) });
          await adjustments.insertAdjustmentHolds(manager, { adjustmentId: pending.id, expiresAt: new Date(targetStart), fragments });
          const pendingRefundIds = await allocateBookingRefund(manager, { bookingId: b.id, amount: -delta,
            operationKey: pending.id, adjustmentId: pending.id, actorId,
            reason: "booking_price_reduction", contextRevisionId: b.current_revision_id });
          return { ok: true, totalAmountMinor: total, adjustmentId: pending.id, adjustmentStatus: "pending",
            refundIds: pendingRefundIds, target: pending.target };
        }
        const expiresAt = new Date(Date.parse(await reservations.readReservationClockTime(manager)) + paymentHoldSeconds() * 1000);
        const adjustment = await adjustments.insertAdjustment(manager, { bookingId: b.id, baseRevisionId: b.current_revision_id, actorId, scope: "owner", requestKey,
          target, originalTotal: b.total_amount_minor, newTotal: total, currency: b.currency, expiresAt });
        await adjustments.insertAdjustmentHolds(manager, { adjustmentId: adjustment.id, expiresAt, fragments });
        await payments.insertAdjustmentAttempt(manager, { id: randomUUID(), bookingId: b.id, adjustmentId: adjustment.id,
          method: "online", provider: "stripe", amountMinor: delta, currency: z.enum(locationCurrencies).parse(b.currency),
          status: "pending", expiresAt });
        return { ok: true, totalAmountMinor: total, adjustmentId: adjustment.id, adjustmentStatus: "pending", target: adjustment.target };
      }
    }
    const changed = r.court_id !== court.id || r.booking_date !== edit.date
      || r.starts_at_minute !== edit.startMinute || r.ends_at_minute !== edit.endMinute;
    const now = await reservations.readReservationClockTime(manager);
    if (timing(a, eligible.bypass, now) !== "eligible") return { ok: false,
      message: "The rescheduling window for this booking has closed." };
    let writeDeadline: string | null = null;
    if (funded) {
      const paid = funded.adjustment;
      if (!paid || new Date(now) >= paid.expiresAt) return unavailableEdit;
      writeDeadline = paid.expiresAt.toISOString();
    }
    if (timestampToEpochMicroseconds(now) >= timestampToEpochMicroseconds(targetStart)) return unavailableEdit;
    const reservationWritten = await reservations.updateCustomerReservationSchedule(manager, r.id, edit, writeDeadline);
    if (!reservationWritten) {
      if (funded) return unavailableEdit;
      throw new revisions.BookingRevisionFenceError("Reservation change was not persisted");
    }
    const revision = buildBookingRevision(terms, { id: revisionId, bookingId: b.id,
      kind: "rescheduled", bookingState: "confirmed", operationKey: funded?.adjustment.requestKey ?? requestKey,
      intentHash, actorUserId: actorId, actorScope: eligible.actorScope, recordedAt: new Date(now),
      adjustmentId: funded?.adjustment.id ?? null, cancellationCause: null }, b.revision);
    await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "confirmed", deadline: writeDeadline });
    notification.value = changed ? bookingNotification("customer_rescheduled", revision, { previous: b.revision }) : null;
    if (notification.value) await enqueueBookingNotification(manager, `revision:${revision.id}`, notification.value);
    return { ok: true, totalAmountMinor: total };
}

type SupersededAttempt = { id: string; provider: PaymentProvider; providerPaymentId: string };
export async function rescheduleCustomerBookingCommand(edit: Edit, actorId: string): Promise<BookingRescheduleResult & { supersededAttempts?: SupersededAttempt[] }> {
  const notification: { value: BookingEmailEvent | null } = { value: null };
  let superseded: SupersededAttempt[] = [];
  const result = await withBooking<BookingRescheduleResult>(edit.id, true, { ok: false, message: "This booking is no longer available to edit." },
    (manager, a) => { superseded = []; return executeReschedule(manager, a, edit, actorId, notification, undefined, superseded); },
    { booking: edit.expectedRevisionId, reservation: edit.expectedUpdatedAt });
  return superseded.length ? { ...result, supersededAttempts: superseded } : result;
}

// Called only inside the verified provider settlement transaction, which already
// owns the configuration, location, booking, reservation and attempt locks.
export async function applyCapturedBookingAdjustment(manager: EntityManager, adjustment: BookingAdjustmentEntity, attemptId: string) {
  const booking = await bookings.findBookingForUpdate(manager, adjustment.bookingId, adjustment.baseRevisionId);
  const reservation = booking && await reservations.findReservationForUpdate(manager, booking.reservation_id, adjustment.target.expectedUpdatedAt);
  const resource = reservation && await reservations.findReservationResourceFacts(manager, reservation.court_id);
  const [location] = resource ? await clubs.lockLocations(manager, [resource.location_id]) : [];
  if (!booking || !reservation || !resource || !location) return { result: unavailableEdit, notification: null };
  const notification: { value: BookingEmailEvent | null } = { value: null };
  const result = await executeReschedule(manager, { booking, reservation, resource, location }, {
    ...adjustment.target, id: adjustment.bookingId, expectedRevisionId: adjustment.baseRevisionId, expectedTotal: adjustment.newTotal, save: true, priceAcknowledged: true,
  }, adjustment.actorId, notification, { id: attemptId, adjustment });
  return { result, notification: notification.value };
}
export async function readCustomerBookingEditContext(id: string, date: string, actorId: string) {
  return withBooking(id, true, null, async (manager, a) => {
    const eligible = await editEligibility(manager, a, actorId);
    if (!eligible.ok) throw new Error(eligible.message);
    const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
    const hours = await reservations.listReservationOpeningHours(manager, a.location.id, date);
    const occupancy = await reservations.listCustomerEditOccupancy(manager, a.location.id, date, a.reservation.id);
    const financial = await bookingFinancials(manager, a.booking.id);
    return { payment_method: a.booking.payment_method,
      financial: { captured: financial.captured, refunded: financial.refunded, refundObligations: financial.obligated,
        netPaid: financial.netPaid, outstanding: Math.max(0, a.booking.total_amount_minor - financial.netPaid) },
      refunds: financial.refunds.map(r => ({ id: r.id, amount: r.amountMinor, status: r.status })),
      location_id: a.location.id, location_timezone: a.location.timezone, court_id: a.reservation.court_id,
      booking_date: a.reservation.booking_date, starts_at_minute: a.reservation.starts_at_minute,
      ends_at_minute: a.reservation.ends_at_minute, updated_at: a.reservation.updated_at,
      current_revision_id: a.booking.current_revision_id, total_amount_minor: a.booking.total_amount_minor, currency: a.booking.currency,
      location: { id: a.location.id, name: a.location.name, timezone: a.location.timezone, is_active: a.location.isActive,
        archived_at: a.location.archivedAt?.toISOString() ?? null, courts: courts.map(c => ({ id: c.id, name: c.name, is_active: true })) },
      hours, occupancy };
  }, undefined, false);
}
