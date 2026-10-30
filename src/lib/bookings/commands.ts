import "server-only";
import { readClubTimezoneError } from "@/lib/club/timezone-policy";

import { timestampToEpochMicroseconds } from "@/lib/precise-time";

import { adjustmentHoldFragments, reassignmentHoldFragments, refundBackedAdjustment, refundBackedOutcome,
  type BookingCancellationCommandResult } from "./domain";
import { buildBookingRevision, capturePricingEvidence, pricingEvidenceSchema, sameRevisionContract, type CoachingEvidence, type PricingEvidence } from "./revision";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError, reservationOverlap } from "@/lib/db/errors";
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
import { findCoachLessonAssignment, lockCoachProfileForBooking } from "@/lib/db/repositories/coaching.repository";
import { authorizeOperationalChange, coachRestrictionPolicy, financialConsequenceAccepted, operationalFinancialQuote,
  type OperationalCapacity, type OperationalChangeInput, type OperationalFinancialQuote, type OperationalRejection } from "./operational-policy";
import { lessonContract, operationalBookingFacts, operationalTerms, readOperationalLessonDay, resolveOperationalTarget,
  scheduleOperationalTarget, writeOperationalChange } from "./operational";
import { findPublicLocationWithCourts } from "@/lib/courts/public";
import { projectCoachingRescheduleStarts, readCoachingLessonDay } from "@/lib/coaching/lesson-availability";
import { quoteCoachingReschedule, type CoachingLessonDay, type CoachingRescheduleResult } from "@/lib/coaching/lesson-quote";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { createLocalIntervalValidator, localStartInstant } from "@/lib/courts/local-time";
import { getCourtStateForDate } from "@/lib/courts/state";
import { mondayWeekday, resolvePricingRule } from "@/lib/pricing/resolution";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { toCalendarPricingRule } from "@/lib/courts/calendar-projections";
import { fitsOpeningHours } from "@/lib/reservations/domain";
import { recordBookingChangeRefundRequested, recordBookingFinancialException, recordBookingTransition } from "@/lib/notifications/events";
import { operationalFinancialNote, refundCompletedNote } from "@/lib/notifications/content";
import { customerBookingNoticeBypass, customerMutationDeadline } from "./self-cancellation";
import type { BookingRescheduleResult } from "./reschedule";

type Scope = "owner" | "admin";
// coach: the lesson's assigned coach cancels it under the Admin (club-side) rules.
type CancellationScope = Scope | "coach";
type Booking = NonNullable<Awaited<ReturnType<typeof bookings.findBookingForUpdate>>>;
type Reservation = NonNullable<Awaited<ReturnType<typeof reservations.findReservationForUpdate>>>;
type Location = Awaited<ReturnType<typeof clubs.lockLocationsForRead>>[number];
type Resource = NonNullable<Awaited<ReturnType<typeof reservations.findReservationResourceFacts>>>;
// locations: every location this transaction locked (the booking's own first among them).
type Aggregate = { booking: Booking; reservation: Reservation; location: Location; resource: Resource; locations: Location[] };
export type BookingAggregate = Aggregate;
class BookingParentChanged extends Error {}
// An expected eligibility refusal whose message is safe to show the booking owner.
export class BookingEditUnavailableError extends Error {}

// The only retry is parent rediscovery, always in a fresh transaction. In
// particular serialization/deadlock failures never become browser stale results.
// target marks a write that may occupy a court and coach on target.date: it follows
// the lesson lock order (configuration → coach profiles FOR SHARE in id order →
// ordered locations, including the destination location and those of the occupying
// coach's expired holds on the date). target.coachUserId names a replacement coach and
// target.locationId a destination location; both are untrusted and only locked here.
// accepted, when given, makes everything after the location locks provisional: the
// payment-hold expiry and the work run in a savepoint that is rolled back unless the
// result is accepted, so a preview or a rejection leaves every hold, adjustment and
// payment attempt exactly as it found them. The location locks are kept either way.
async function withBooking<T>(id: string, configuration: boolean, unavailable: T,
  work: (manager: EntityManager, aggregate: Aggregate) => Promise<T>,
  tokens?: { booking: string; reservation: string }, occupancyWrite = true,
  target?: { date: string; coachUserId?: string; locationId?: string }, accepted?: (result: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await inTransaction(async (manager) => {
        if (configuration) await clubs.lockConfigurationForRead(manager);
        const parent = await bookings.discoverBookingLocation(manager, id);
        if (!parent) return unavailable;
        const occupancy = target && occupancyWrite && configuration ? target : null;
        // The coach who will occupy the date: a requested replacement, else the lesson's own coach.
        const occupying = occupancy && parent.coach_user_id ? (occupancy.coachUserId ?? parent.coach_user_id).toLowerCase() : null;
        // An archived profile has no row to share; eligibility then rejects the lesson.
        const coaches = [...new Set([parent.coach_user_id?.toLowerCase(), occupying].filter((coach): coach is string => !!coach))].sort();
        if (occupancy) for (const coach of coaches) await lockCoachProfileForBooking(manager, coach);
        // Expired coach holds no longer occupy the coach, yet the coach exclusion
        // still covers them on any court or location until their expiry releases them.
        const discovered = occupying ? await reservations.listExpiredCoachHoldCourts(manager, occupying, occupancy!.date) : [];
        const destination = occupancy?.locationId?.toLowerCase();
        const locked = await (occupancyWrite ? clubs.lockLocations : clubs.lockLocationsForRead)(manager,
          [parent.location_id, ...(destination ? [destination] : []), ...discovered.map((row) => row.location_id)]);
        const location = locked.find((candidate) => candidate.id === parent.location_id);
        if (!location) return unavailable;
        const lockedWork = async (): Promise<T> => {
          if (occupancyWrite && configuration) {
            await expirePaymentHoldsAtLocation(manager, location.id);
            if (destination && destination !== location.id && locked.some((candidate) => candidate.id === destination))
              await expirePaymentHoldsAtLocation(manager, destination);
          }
          if (occupying) {
            const expired = await reservations.listExpiredCoachHoldCourts(manager, occupying, occupancy!.date);
            if (expired.some((row) => !locked.some((candidate) => candidate.id === row.location_id))) throw new BookingParentChanged();
            for (const row of expired) await expirePaymentHoldsAtLocation(manager, row.location_id, { courtId: row.court_id });
          }
          const booking = await bookings.findBookingForUpdate(manager, id, tokens?.booking);
          if (!booking) return unavailable;
          const reservation = await reservations.findReservationForUpdate(manager, booking.reservation_id, tokens?.reservation);
          if (!reservation) return unavailable;
          const resource = await reservations.findReservationResourceFacts(manager, reservation.court_id);
          if (!resource || resource.location_id !== parent.location_id) throw new BookingParentChanged();
          if (target && reservation.coach_user_id !== parent.coach_user_id) throw new BookingParentChanged();
          return work(manager, { booking, reservation, location, resource, locations: locked });
        };
        if (!accepted) return lockedWork();
        // Like a superseded proposal, the expiry is provisional until the change is accepted.
        await manager.query("SAVEPOINT provisional_booking_change");
        const result = await lockedWork();
        if (!accepted(result)) await manager.query("ROLLBACK TO SAVEPOINT provisional_booking_change");
        await manager.query("RELEASE SAVEPOINT provisional_booking_change");
        return result;
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

const cancellationCauses = { owner: "owner_cancelled", admin: "admin_cancelled", coach: "coach_cancelled" } as const;

export async function cancelCustomerBookingCommand(id: string, actorId: string, scope: CancellationScope, explanation?: string): Promise<BookingCancellationCommandResult> {
  const explanationInput = z.string().trim().max(500).optional().safeParse(explanation);
  if (!explanationInput.success || scope !== "admin" && explanationInput.data) return { outcome: "unavailable" };
  const cancellationExplanation = explanationInput.data || undefined;
  const unavailable: BookingCancellationCommandResult = { outcome: "unavailable" };
  const result = await withBooking<BookingCancellationCommandResult>(id, false, unavailable, async (manager, a) => {
    const b = a.booking, r = a.reservation;
    const financial = await bookingFinancials(manager, b.id, true);
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active") return { outcome: scope === "owner" ? "inactive" : "unavailable" };
    // Staff (Admin, or the assigned Coach) cancel on the club's behalf under the same rules,
    // authorized by the shared operational policy for the scope's own permission set.
    const staff = scope !== "owner";
    if (scope === "owner" ? b.account_user_id !== actorId
      : !authorizeOperationalChange(scope, actorId, actor, operationalBookingFacts(a)).ok) return unavailable;
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
    if (b.status !== "confirmed" || r.status !== "active" || staff && !activeOriginal(a)) return unavailable;
    const bypass = staff || customerBookingNoticeBypass(actor.roles);
    let checkedAt = await reservations.readReservationClockTime(manager);
    let eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: staff ? "unavailable" : eligible };
    const refund = b.payment_method === "online" && financial.refundable > 0;
    checkedAt = await reservations.readReservationClockTime(manager);
    eligible = timing(a, bypass, checkedAt);
    if (eligible !== "eligible") return { outcome: staff ? "unavailable" : eligible };
    if (open.discarded) {
      await adjustments.updateAdjustment(manager, open.discarded.id, "cancelled");
      await adjustments.releaseAdjustmentHolds(manager, open.discarded.id);
    }
    const actorScope = scope === "owner" ? actorScopeOf(actor.roles) : scope;
    if (refund) {
      // Eligibility is decided now and preserved by the request; the booking,
      // occupancy and contract stay unchanged until verified refund completion.
      const request = await adjustments.insertAdjustment(manager, { bookingId: b.id, baseRevisionId: b.current_revision_id,
        // The request's rule set is staff; target.actorScope keeps the Coach attribution.
        actorId, scope: staff ? "admin" : "owner", kind: "cancellation", requestKey: `cancellation:${randomUUID()}`,
        target: { courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute,
          expectedUpdatedAt: r.updated_at, courtName: b.revision.courtName, locationName: b.revision.locationName,
          timezone: b.revision.timezone, actorScope, ...(cancellationExplanation ? { cancellationExplanation } : {}) },
        originalTotal: b.total_amount_minor, newTotal: b.total_amount_minor, currency: b.currency,
        expiresAt: new Date(checkedAt), createdAt: new Date(checkedAt) });
      const refundIds = await allocateBookingRefund(manager, { bookingId: b.id, amount: financial.refundable,
        operationKey: request.id, adjustmentId: request.id, actorId, reason: "booking_cancellation",
        contextRevisionId: b.current_revision_id });
      return { outcome: "cancellation_pending", adjustmentId: request.id, refundIds };
    }
    // The existing cancellation request also retains an explanation for cancellations
    // without a refund. Its applied revision and history reference the same record.
    const cancellationRecord = cancellationExplanation ? await adjustments.insertAdjustment(manager, {
      bookingId: b.id, baseRevisionId: b.current_revision_id, actorId, scope: "admin", kind: "cancellation",
      requestKey: `cancellation:${randomUUID()}`, status: "applied",
      target: { courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute,
        expectedUpdatedAt: r.updated_at, courtName: b.revision.courtName, locationName: b.revision.locationName,
        timezone: b.revision.timezone, actorScope, cancellationExplanation },
      originalTotal: b.total_amount_minor, newTotal: b.total_amount_minor, currency: b.currency,
      expiresAt: new Date(checkedAt), createdAt: new Date(checkedAt) }) : null;
    const revision = buildBookingRevision(b.revision, { id: randomUUID(), bookingId: b.id,
      kind: "cancelled", bookingState: "cancelled", operationKey: "cancellation", intentHash: "cancellation",
      actorUserId: actorId, actorScope, recordedAt: new Date(checkedAt), adjustmentId: cancellationRecord?.id ?? null,
      cancellationCause: cancellationCauses[scope] }, b.revision);
    await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "cancelled" });
    await reservations.updateCustomerReservationCancellation(manager, r.id, actorId, checkedAt);
    await recordBookingTransition(manager, revision);
    return { outcome: "cancelled", refundIds: [] };
  });
  return result;
}

// Decides a refund-backed change (cancellation or price reduction) exactly once,
// only after every refund obligation has succeeded. Called after refund commits and by
// any later check of a refund (Stripe webhook or Admin); the pending -> applied/unsuccessful
// transition under the booking lock makes replays no-ops.
export async function resolveRefundBackedAdjustment(adjustmentId: string): Promise<BookingAdjustmentEntity["status"] | null> {
  const found = await adjustments.findAdjustment((await getDataSource()).manager, adjustmentId);
  if (!found || found.status !== "pending" || !refundBackedAdjustment(found)) return found?.status ?? null;
  // A staff change may move the booking to another location or coach: the apply takes
  // the same occupancy locks as the change itself, including the destination's.
  const placement = found.target.locationId ? { date: found.target.date, locationId: found.target.locationId,
    coachUserId: found.target.coachUserId } : undefined;
  const status = await withBooking<BookingAdjustmentEntity["status"] | null>(found.bookingId, true, null, async (manager, a) => {
    const adjustment = await adjustments.findAdjustment(manager, adjustmentId);
    if (!adjustment || adjustment.bookingId !== a.booking.id) return null;
    if (adjustment.status !== "pending") return adjustment.status;
    const { refunds } = await payments.loadBookingFinancialFacts(manager, a.booking.id, true);
    const own = refunds.filter(refund => refund.adjustmentId === adjustment.id);
    const outcome = refundBackedOutcome(own.map(refund => refund.status));
    if (outcome === "waiting") {
      // Refund commands commit each failure with its exception evidence. Do not
      // reinterpret a failed summary here: it may be an already-recorded reversal.
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
      // The final definitive refund failure already records this identity. Keep
      // this idempotent fallback for pending changes created before that writer.
      await recordBookingFinancialException(manager, { key: `adjustment:${adjustment.id}:abandoned`,
        bookingId: a.booking.id, revisionId: a.booking.current_revision_id, adjustmentId: adjustment.id,
        kind: adjustment.kind === "cancellation" ? "cancellation_rejected" : "modification_rejected" });
      return "unsuccessful";
    }
    const b = a.booking, r = a.reservation;
    const now = await reservations.readReservationClockTime(manager);
    if (b.current_revision_id !== adjustment.baseRevisionId)
      throw new revisions.BookingRevisionFenceError("Booking changed while a refund-backed change was pending");
    const actorScope = adjustment.target.actorScope ?? (adjustment.scope === "admin" ? "admin" : "customer");
    if (adjustment.kind === "cancellation") {
      if (b.status !== "confirmed" || r.status !== "active") throw new Error("Pending cancellation lost its booking state");
      const revision = buildBookingRevision(b.revision, { id: randomUUID(), bookingId: b.id,
        kind: "cancelled", bookingState: "cancelled", operationKey: "cancellation", intentHash: "cancellation",
        actorUserId: adjustment.actorId, actorScope, recordedAt: new Date(now), adjustmentId: adjustment.id,
        cancellationCause: cancellationCauses[actorScope === "coach" ? "coach" : adjustment.scope] }, b.revision);
      await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "cancelled" });
      await reservations.updateCustomerReservationCancellation(manager, r.id, adjustment.actorId, now);
      await adjustments.updateAdjustment(manager, adjustment.id, "applied");
      await recordBookingTransition(manager, revision, "The cancellation refund completed.");
      return "applied";
    }
    // Reduction: the accepted quote is applied as refunded, never repriced. Its
    // target fragments stayed held, so the original row can move onto them.
    const target = adjustment.target;
    // A staff change also assigns its destination location and, when reassigned, coach.
    const operational = target.locationId !== undefined;
    await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
    await manager.query("SAVEPOINT refund_adjustment_apply");
    let moved = false;
    try {
      moved = operational ? await reservations.updateReservationAssignment(manager, r.id, { courtId: target.courtId, date: target.date,
        startMinute: target.startMinute, endMinute: target.endMinute, coachUserId: target.coachUserId ?? r.coach_user_id })
        : await reservations.updateCustomerReservationSchedule(manager, r.id, target);
    }
    catch (error) {
      // Either exclusion (court, or the lesson's coach) leaves the original booking in place.
      if (!reservationOverlap(normalizeDatabaseError(error))) throw error;
      await manager.query("ROLLBACK TO SAVEPOINT refund_adjustment_apply");
    }
    await manager.query("RELEASE SAVEPOINT refund_adjustment_apply");
    if (!moved) {
      // Unavoidable exception: the refund already left; the original booking stays.
      logger.error({ event: "bookings.refunded_change_unapplied", adjustmentId: adjustment.id, bookingId: b.id },
        "Refund completed but the booking change could not be applied");
      await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
      await recordBookingFinancialException(manager, { key: `adjustment:${adjustment.id}:unapplied`,
        bookingId: b.id, revisionId: b.current_revision_id, adjustmentId: adjustment.id, kind: "refunded_modification_unapplied" });
      return "unsuccessful";
    }
    const terms = { ...b.revision, courtId: target.courtId, courtName: target.courtName, locationName: target.locationName,
      timezone: target.timezone, bookingDate: target.date, startMinute: target.startMinute, endMinute: target.endMinute,
      ...(target.locationId ? { locationId: target.locationId } : {}),
      ...(target.coachUserId && target.coachName ? { coachUserId: target.coachUserId, coachName: target.coachName } : {}),
      totalAmountMinor: adjustment.newTotal, pricingEvidence: pricingEvidenceSchema.parse(target.pricingEvidence) };
    const revision = buildBookingRevision(terms, { id: randomUUID(), bookingId: b.id, kind: "rescheduled", bookingState: "confirmed",
      operationKey: adjustment.requestKey, intentHash: target.intentHash ?? createHash("sha256").update(adjustment.id).digest("hex"),
      actorUserId: adjustment.actorId, actorScope, recordedAt: new Date(now), adjustmentId: adjustment.id,
      cancellationCause: null }, b.revision);
    await revisions.advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "confirmed" });
    await adjustments.updateAdjustment(manager, adjustment.id, "applied");
    // A staff change states the verified refunded amount beside the schedule it replaced.
    if (operational) await recordBookingTransition(manager, revision,
      refundCompletedNote(own.reduce((sum, refund) => sum + refund.amountMinor, 0), revision.currency), b.revision);
    else await recordBookingTransition(manager, revision, "The price reduction refund completed.");
    return "applied";
  }, undefined, true, placement);
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

// funded: an accepted, paid proposal; its coach authorization was checked when proposed.
async function editEligibility(manager: EntityManager, a: Aggregate, actorId: string, funded = false) {
  const actor = await lockReservationActorFacts(manager, actorId);
  if (actor?.status !== "active") return { ok: false as const, message: "An active account is required to edit a booking." };
  if (a.booking.account_user_id !== actorId)
    return { ok: false as const, message: "This booking is no longer available to edit." };
  const lesson = lessonContract(a);
  if (lesson === false || a.booking.status !== "confirmed" || a.reservation.status !== "active" || !activeOriginal(a)
    || a.location.currency !== a.booking.currency) return { ok: false as const,
      message: "This booking is no longer available to edit." };
  if (lesson && !funded) {
    // The same coach must still be able to teach this lesson here; another coach is never substituted.
    const coach = await lockReservationActorFacts(manager, lesson.coachUserId);
    const assignment = await findCoachLessonAssignment(manager, lesson.coachUserId, a.location.id, lesson.programId);
    if (coach?.status !== "active" || !coach.roles.includes("coach") || !assignment.profile) return { ok: false as const,
      message: "This lesson's coach is no longer available for lessons. Contact the club to rearrange it." };
    if (!assignment.location) return { ok: false as const,
      message: "This lesson's coach no longer teaches at this location. Contact the club to rearrange it." };
    if (!assignment.program) return { ok: false as const,
      message: "This lesson's coach no longer offers this program. Contact the club to rearrange it." };
  }
  const bypass = customerBookingNoticeBypass(actor.roles);
  if (timing(a, bypass, await reservations.readReservationClockTime(manager)) !== "eligible")
    return { ok: false as const, message: "The rescheduling window for this booking has closed." };
  return { ok: true as const, bypass, lesson, actorScope: actor.roles.includes("admin") ? "admin_owner" as const
    : actor.roles.includes("coach") ? "coach_owner" as const : "customer" as const };
}

const lessonMessages: Record<Exclude<CoachingRescheduleResult, { ok: true }>["reason"], string> = {
  "invalid-time": "Choose a lesson start on a 30-minute boundary that keeps the lesson's length.",
  "coach-unavailable": "The coach is not available at the selected time.",
  "coach-booked": "The coach is no longer available at the selected time. The booking has not changed.",
  "court-unavailable": "That court is no longer available. The booking has not changed.",
  unpriced: "No complete pricing is available for this interval. Choose another interval.",
};

// The purchased lesson at the requested slot under the current operational
// availability, read after the booking's locks. The lesson's own reservation is
// excluded so it never conflicts with itself; the coaching fee is never repriced.
async function quoteLesson(manager: EntityManager, a: Aggregate, edit: Edit, coaching: CoachingEvidence, coachUserId: string) {
  const now = new Date(await reservations.readReservationClockTime(manager));
  const location = await findPublicLocationWithCourts(manager, a.location.id, now);
  if (!location) return { ok: false as const, message: "This location is not accepting lesson bookings right now." };
  const day = await readCoachingLessonDay(manager, location, coachUserId, edit.date, now, a.reservation.id);
  if (!day) throw new Error("Malformed lesson day.");
  if (edit.date < day.today) return unavailableEdit;
  const result = quoteCoachingReschedule(day, coaching, { courtId: edit.courtId, startMinute: edit.startMinute });
  return result.ok ? result : { ok: false as const, message: lessonMessages[result.reason] };
}

async function executeReschedule(manager: EntityManager, a: Aggregate, edit: Edit, actorId: string,
  funded?: { id: string; adjustment: BookingAdjustmentEntity; deadline: Date | null },
  superseded?: SupersededAttempt[]): Promise<BookingRescheduleResult> {
    // Funded settlement honors the already accepted target and its protected holds.
    // Only a new scheduling intent is refused for legacy configuration mismatch.
    if (!funded) {
      const timezoneError = await readClubTimezoneError(manager);
      if (timezoneError) return { ok: false, message: timezoneError };
    }
    const lockedFinancials = edit.save && !funded && a.booking.payment_method === "online"
      ? await bookingFinancials(manager,a.booking.id,true) : null;
    const intentHash = createHash("sha256").update(JSON.stringify({ actorId, base: edit.expectedRevisionId,
      courtId: edit.courtId, date: edit.date, start: edit.startMinute, end: edit.endMinute, total: edit.expectedTotal })).digest("hex");
    const requestKey = edit.requestId ?? intentHash;
    const eligible = await editEligibility(manager, a, actorId, Boolean(funded));
    if (!eligible.ok) return eligible;
    const b = a.booking, r = a.reservation;
    if (eligible.lesson && edit.courtId !== r.court_id)
      return { ok: false, message: "A coaching lesson keeps its original court. Choose a new date or start time." };
    if (eligible.lesson && edit.endMinute - edit.startMinute !== eligible.lesson.coaching.durationMinutes)
      return { ok: false, message: "A coaching lesson keeps its original length. Choose a new start time." };
    // A new intent must name existing local times that elapse exactly as priced,
    // before any earlier proposal is discarded or a financial operation is created.
    if (!funded && !createLocalIntervalValidator(a.location.timezone, edit.date)(edit.startMinute, edit.endMinute)) return unavailableEdit;
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
      // unpaid earlier proposal is superseded only by a successful replacement and
      // its provider payment resolved after commit.
      const open = await adjustments.findPendingAdjustment(manager, b.id);
      if (open) {
        if (open.kind === "cancellation") return { ok: false,
          message: "A cancellation request for this booking is being processed. The booking has not changed." };
        if (refundBackedAdjustment(open)) return { ok: false,
          message: "A previous change to this booking is waiting for its refund. The booking has not changed." };
        if (await adjustments.hasLivePayment(manager, open.id)) return { ok: false,
          message: "A previous additional payment is still processing. The booking has not changed." };
        // Discarded provisionally so the replacement is validated without the earlier
        // proposal's holds; a rejected request rolls back and leaves it intact.
        await manager.query("SAVEPOINT supersede_adjustment");
        const discarded = await discardUnpaidAdjustment(manager, open.id);
        const result = await rescheduleTarget(manager, a, edit, actorId, eligible, intentHash, requestKey, lockedFinancials);
        if (!result.ok) await manager.query("ROLLBACK TO SAVEPOINT supersede_adjustment");
        await manager.query("RELEASE SAVEPOINT supersede_adjustment");
        if (result.ok && discarded) superseded?.push(discarded);
        return result;
      }
    }
    return rescheduleTarget(manager, a, edit, actorId, eligible, intentHash, requestKey, lockedFinancials, funded);
}

async function discardUnpaidAdjustment(manager: EntityManager, adjustmentId: string): Promise<SupersededAttempt | null> {
  await adjustments.updateAdjustment(manager, adjustmentId, "cancelled");
  await adjustments.releaseAdjustmentHolds(manager, adjustmentId);
  const attempt = await adjustments.adjustmentAttempt(manager, adjustmentId);
  const locked = attempt && await payments.lockCheckoutAttempt(manager, attempt.id);
  if (locked?.status !== "pending" || !locked.provider) return null;
  // One pending attempt per booking: close it like the cutoff sweep does.
  // A later capture is still recorded and refunded, never applied.
  await payments.revokeCheckoutCapability(manager, locked.id);
  await payments.expirePendingAttempt(manager, locked.id);
  return locked.providerPaymentId ? { id: locked.id, provider: locked.provider, providerPaymentId: locked.providerPaymentId } : null;
}

type EditEligibility = Extract<Awaited<ReturnType<typeof editEligibility>>, { ok: true }>;
async function rescheduleTarget(manager: EntityManager, a: Aggregate, edit: Edit, actorId: string, eligible: EditEligibility,
  intentHash: string, requestKey: string, lockedFinancials: Awaited<ReturnType<typeof bookingFinancials>> | null,
  funded?: { id: string; adjustment: BookingAdjustmentEntity; deadline: Date | null }): Promise<BookingRescheduleResult> {
    const b = a.booking, r = a.reservation;
    if (!b.token_matches || !r.token_matches) return { ok: false, reason: "stale",
      message: "This booking has changed since you opened it. Close and reopen its details." };
    const targetStart = localStartInstant(a.location.timezone, edit.date, edit.startMinute);
    let court: { id: string; name: string }, total: number, pricingEvidence: () => PricingEvidence;
    if (eligible.lesson && funded) {
      // The accepted, paid proposal is the contract: its held target and snapshotted
      // quote are applied as accepted, never repriced or rechecked against the coach's schedule.
      const accepted = pricingEvidenceSchema.safeParse(funded.adjustment.target.pricingEvidence);
      const target = (await clubs.listCheckoutLocationCourts(manager, a.location.id)).find(c => c.id === edit.courtId);
      if (!accepted.success || !accepted.data.coaching || !target) return unavailableEdit;
      if (timestampToEpochMicroseconds(await reservations.readReservationClockTime(manager)) >= timestampToEpochMicroseconds(targetStart)) return unavailableEdit;
      const evidence = accepted.data;
      court = target; total = funded.adjustment.newTotal; pricingEvidence = () => evidence;
    } else if (eligible.lesson) {
      const quoted = await quoteLesson(manager, a, edit, eligible.lesson.coaching, eligible.lesson.coachUserId);
      if (!quoted.ok) return quoted;
      const { quote } = quoted;
      court = quote.court; total = quote.totalAmountMinor; pricingEvidence = () => quote.pricingEvidence;
    } else {
      const courts = await clubs.listCheckoutLocationCourts(manager, a.location.id);
      const target = courts.find(c => c.id === edit.courtId);
      const hours = await reservations.listReservationOpeningHours(manager, a.location.id, edit.date);
      if (!target || !fitsOpeningHours(hours, edit.date, edit.startMinute, edit.endMinute)) return unavailableEdit;
      if (timestampToEpochMicroseconds(await reservations.readReservationClockTime(manager)) >= timestampToEpochMicroseconds(targetStart)) return unavailableEdit;
      if (await hasOccupancyConflict(manager, edit, a.location.id, r.id)) return conflict;
      const coverage = await clubs.listCheckoutCourtCoverage(manager, target.id, edit.date);
      const state = getCourtStateForDate(target.environment, coverage.map(c => ({ starts_on: c.startsOn, ends_on: c.endsOn })), edit.date);
      const rules = await listCheckoutPricing(manager, target.id, mondayWeekday(edit.date), edit.date);
      const pricing = rules.map(toCalendarPricingRule);
      const times = Array.from({ length: (edit.endMinute - edit.startMinute) / 30 }, (_, i) => edit.startMinute + i * 30);
      const hourlyPrices = times.map(minute => {
        const rule = resolvePricingRule(pricing, { court_id: target.id, court_state: state, date: edit.date, minute });
        return rule && minute + 30 <= rule.ends_at_minute ? rule.price_per_hour_minor : null;
      });
      const selection = getCalendarSelection({ courtId: target.id, times, cells: times.map(() => "available"), hourlyPrices }, 0, times.length);
      if (!selection || selection.priceMinor > 2147483647) return { ok: false,
        message: "No complete pricing is available for this interval. Choose another interval." };
      const rental = selection.priceMinor;
      court = target; total = rental;
      pricingEvidence = () => capturePricingEvidence(pricing, { courtId: target.id, courtState: state, date: edit.date,
        startMinute: edit.startMinute, endMinute: edit.endMinute, total: rental });
    }
    if (!edit.save) return { ok: true, totalAmountMinor: total };
    if (edit.expectedTotal !== total || total !== b.total_amount_minor && !edit.priceAcknowledged)
      return { ok: false, reason: "price_changed", totalAmountMinor: total,
        message: "The price has changed. Confirm the new total before saving." };
    const terms = { ...b.revision, courtId: court.id, courtName: court.name,
      locationName: a.location.name, timezone: a.location.timezone, bookingDate: edit.date,
      startMinute: edit.startMinute, endMinute: edit.endMinute, totalAmountMinor: total, pricingEvidence: pricingEvidence() };
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
        const fragments = adjustmentHoldFragments({ courtId:r.court_id,date:r.booking_date,startMinute:r.starts_at_minute,endMinute:r.ends_at_minute }, edit, r.coach_user_id);
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
        // A lesson's accepted quote is snapshotted so settlement applies it without repricing.
        const adjustment = await adjustments.insertAdjustment(manager, { bookingId: b.id, baseRevisionId: b.current_revision_id, actorId, scope: "owner", requestKey,
          target: eligible.lesson ? { ...target, pricingEvidence: terms.pricingEvidence } : target, originalTotal: b.total_amount_minor, newTotal: total, currency: b.currency, expiresAt });
        await adjustments.insertAdjustmentHolds(manager, { adjustmentId: adjustment.id, expiresAt, fragments });
        await payments.insertAdjustmentAttempt(manager, { id: randomUUID(), bookingId: b.id, adjustmentId: adjustment.id,
          method: "online", provider: "stripe", amountMinor: delta, currency: z.enum(locationCurrencies).parse(b.currency),
          status: "pending", expiresAt });
        return { ok: true, totalAmountMinor: total, adjustmentId: adjustment.id, adjustmentStatus: "pending", target: adjustment.target };
      }
    }
    const now = await reservations.readReservationClockTime(manager);
    if (timing(a, eligible.bypass, now) !== "eligible") return { ok: false,
      message: "The rescheduling window for this booking has closed." };
    let writeDeadline: string | null = null;
    if (funded?.deadline) {
      // Unaccepted legacy captures must still settle before the original cutoff.
      if (new Date(now) >= funded.deadline) return unavailableEdit;
      writeDeadline = funded.deadline.toISOString();
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
    await recordBookingTransition(manager, revision);
    return { ok: true, totalAmountMinor: total };
}

type SupersededAttempt = { id: string; provider: PaymentProvider; providerPaymentId: string };
export async function rescheduleCustomerBookingCommand(edit: Edit, actorId: string): Promise<BookingRescheduleResult & { supersededAttempts?: SupersededAttempt[] }> {
  let superseded: SupersededAttempt[] = [];
  const result = await withBooking<BookingRescheduleResult>(edit.id, true, { ok: false, message: "This booking is no longer available to edit." },
    (manager, a) => { superseded = []; return executeReschedule(manager, a, edit, actorId, undefined, superseded); },
    { booking: edit.expectedRevisionId, reservation: edit.expectedUpdatedAt }, true, { date: edit.date },
    // Only an accepted save commits; a quote or rejection keeps every hold and payment as found.
    (result) => edit.save && result.ok);
  return superseded.length ? { ...result, supersededAttempts: superseded } : result;
}

// Called only inside the verified provider settlement transaction, which already
// owns the configuration, location, booking, reservation and attempt locks.
export async function applyCapturedBookingAdjustment(manager: EntityManager, adjustment: BookingAdjustmentEntity, attemptId: string,
  deadline: Date | null) {
  const booking = await bookings.findBookingForUpdate(manager, adjustment.bookingId, adjustment.baseRevisionId);
  const reservation = booking && await reservations.findReservationForUpdate(manager, booking.reservation_id, adjustment.target.expectedUpdatedAt);
  const resource = reservation && await reservations.findReservationResourceFacts(manager, reservation.court_id);
  const [location] = resource ? await clubs.lockLocations(manager, [resource.location_id]) : [];
  if (!booking || !reservation || !resource || !location) return { result: unavailableEdit };
  const result = await executeReschedule(manager, { booking, reservation, resource, location, locations: [location] }, {
    ...adjustment.target, id: adjustment.bookingId, expectedRevisionId: adjustment.baseRevisionId, expectedTotal: adjustment.newTotal, save: true, priceAcknowledged: true,
  }, adjustment.actorId, { id: attemptId, adjustment, deadline });
  return { result };
}
// The purchased lesson's fixed terms and every start it can move to on the date,
// after its owner and eligibility were authorized under the booking's locks.
// operational: a staff (Coach) read from the operational configuration, which does
// not require the location to be published; a customer reads the public day.
async function readLessonEditContext(manager: EntityManager, a: Aggregate, date: string,
  lesson: { coachUserId: string; programId: string; coaching: CoachingEvidence }, operational: boolean) {
  const now = new Date(await reservations.readReservationClockTime(manager));
  let day: Omit<CoachingLessonDay, "coaching"> | null;
  if (operational) day = await readOperationalLessonDay(manager, a.location, lesson.coachUserId, date, a.reservation.id, now);
  else {
    const location = await findPublicLocationWithCourts(manager, a.location.id, now);
    if (!location) throw new BookingEditUnavailableError("This location is not accepting lesson bookings right now.");
    day = await readCoachingLessonDay(manager, location, lesson.coachUserId, date, now, a.reservation.id);
  }
  if (!day) throw new Error("Malformed lesson day.");
  const v = a.booking.revision;
  return { coach: { id: lesson.coachUserId, name: v.coachName ?? "" },
    program: { id: lesson.programId, name: v.coachingProgramName ?? "", participantCount: lesson.coaching.participantCount,
      courtRentalIncluded: lesson.coaching.courtRentalIncluded },
    durationMinutes: lesson.coaching.durationMinutes, coachingAmountMinor: lesson.coaching.amountMinor,
    starts: projectCoachingRescheduleStarts({ ...day, location: { ...day.location,
      courts: day.location.courts.filter(court => court.id === a.reservation.court_id) } }, lesson.coaching) };
}

export async function readCustomerBookingEditContext(id: string, date: string, actorId: string) {
  return withBooking(id, true, null, async (manager, a) => {
    const eligible = await editEligibility(manager, a, actorId);
    if (!eligible.ok) throw new BookingEditUnavailableError(eligible.message);
    return readEditContext(manager, a, date, eligible.lesson || null, false);
  }, undefined, false);
}

async function readEditContext(manager: EntityManager, a: Aggregate, date: string,
  lesson: { coachUserId: string; programId: string; coaching: CoachingEvidence } | null, operational: boolean) {
  const coaching = lesson ? await readLessonEditContext(manager, a, date, lesson, operational) : null;
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
      archived_at: a.location.archivedAt?.toISOString() ?? null,
      courts: courts.map(c => ({ id: c.id, name: c.name, is_active: true, environment: c.environment })) },
    hours, occupancy, coaching };
}

// Staff operational eligibility shared by Admin and Coach changes, rechecked under the
// booking's locks: the capacity's authorization (active account, current role and, for a
// Coach, current assignment), a confirmed booking with an intact contract on an active
// original court and location in its currency, and no pending change. Like staff
// cancellation, the customer notice window does not apply; callers check the start.
async function operationalEligibility(manager: EntityManager, a: Aggregate, capacity: OperationalCapacity, actorId: string) {
  const actor = await lockReservationActorFacts(manager, actorId);
  const authorization = authorizeOperationalChange(capacity, actorId, actor, operationalBookingFacts(a));
  const lesson = lessonContract(a);
  if (!authorization.ok || lesson === false || a.booking.status !== "confirmed" || a.reservation.status !== "active")
    return { ok: false as const, reason: "unavailable" as const };
  if (!activeOriginal(a)) return { ok: false as const, reason: "inactive_original" as const };
  if (a.location.currency !== a.booking.currency) return { ok: false as const, reason: "cross_currency" as const };
  // Any pending change (a customer modification, a refund-backed change or a cancellation)
  // is bound to the current revision; moving the booking underneath it is never allowed.
  if (await adjustments.findPendingAdjustment(manager, a.booking.id)) return { ok: false as const, reason: "change_pending" as const };
  return { ok: true as const, authorization, lesson };
}

// The assigned Coach's lesson: the shared staff eligibility, plus the Coach's own
// current profile, location and program assignment, and a lesson not yet started.
async function coachLessonEligibility(manager: EntityManager, a: Aggregate, actorId: string) {
  const unavailable = { ok: false as const, message: "This lesson is no longer available to reschedule." };
  const eligible = await operationalEligibility(manager, a, "coach", actorId);
  if (!eligible.ok) return eligible.reason === "change_pending" ? { ok: false as const,
    message: "A change to this lesson is still being processed. The lesson has not changed." } : unavailable;
  const { lesson } = eligible;
  if (!lesson) return unavailable;
  const assignment = await findCoachLessonAssignment(manager, actorId, a.location.id, lesson.programId);
  if (!assignment.profile) return { ok: false as const,
    message: "Your coach profile is not available for lessons. Contact the club to rearrange this lesson." };
  if (!assignment.location) return { ok: false as const,
    message: "You no longer teach at this location. Contact the club to rearrange this lesson." };
  if (!assignment.program) return { ok: false as const,
    message: "You no longer offer this program. Contact the club to rearrange this lesson." };
  if (timing(a, true, await reservations.readReservationClockTime(manager)) !== "eligible")
    return { ok: false as const, message: "This lesson has started and can no longer be rescheduled." };
  return { ok: true as const, lesson };
}

// The assigned Coach's fixed lesson terms and every start it can move to on the date.
export async function readCoachLessonEditContext(id: string, date: string, actorId: string) {
  return withBooking(id, true, null, async (manager, a) => {
    const eligible = await coachLessonEligibility(manager, a, actorId);
    if (!eligible.ok) throw new BookingEditUnavailableError(eligible.message);
    return readEditContext(manager, a, date, eligible.lesson, true);
  }, undefined, false);
}

// The assigned Coach moves their lesson to another date or start on its court, through
// the shared operational foundation: the lesson locks, target resolution, scheduling
// (coach windows, time off, coach and court occupancy, live and payment-protected holds,
// DST), stale-revision fence and revision history. The Coach's own restrictions are
// enforced here. The agreed contract is preserved: the total and its pricing evidence
// are carried over unchanged, so no payment, refund or adjustment is ever created.
async function executeCoachReschedule(manager: EntityManager, a: Aggregate, edit: Edit, actorId: string): Promise<BookingRescheduleResult> {
  const timezoneError = await readClubTimezoneError(manager);
  if (timezoneError) return { ok: false, message: timezoneError };
  const eligible = await coachLessonEligibility(manager, a, actorId);
  if (!eligible.ok) return eligible;
  const { lesson } = eligible, b = a.booking, r = a.reservation;
  if (edit.courtId !== r.court_id)
    return { ok: false, message: "A coaching lesson keeps its original court. Choose a new date or start time." };
  if (edit.endMinute - edit.startMinute !== lesson.coaching.durationMinutes)
    return { ok: false, message: "A coaching lesson keeps its original length. Choose a new start time." };
  if (!createLocalIntervalValidator(a.location.timezone, edit.date)(edit.startMinute, edit.endMinute)) return unavailableEdit;
  const intentHash = createHash("sha256").update(JSON.stringify({ scope: "coach", actorId, base: edit.expectedRevisionId,
    courtId: edit.courtId, date: edit.date, start: edit.startMinute, end: edit.endMinute })).digest("hex");
  const requestKey = edit.requestId ?? intentHash;
  if (edit.save) {
    const applied = await revisions.findRevisionOperation(manager, b.id, requestKey);
    if (applied) return applied.intentHash === intentHash ? { ok: true, totalAmountMinor: applied.totalAmountMinor }
      : { ok: false, message: "This operation key was already used for different booking details." };
  }
  if (!b.token_matches || !r.token_matches) return { ok: false, reason: "stale",
    message: "This lesson has changed since you opened it. Close and reopen its details." };
  const resolved = await resolveOperationalTarget(manager, a,
    { locationId: a.location.id, courtId: edit.courtId, date: edit.date, startMinute: edit.startMinute });
  if (!resolved.ok) return unavailableEdit;
  const scheduled = await scheduleOperationalTarget(manager, a, resolved.target, "enforce", lesson.coaching);
  if (!scheduled.ok) return scheduled.reason in lessonMessages
    ? { ok: false, message: lessonMessages[scheduled.reason as keyof typeof lessonMessages] } : unavailableEdit;
  if (!edit.save) return { ok: true, totalAmountMinor: b.total_amount_minor };
  const now = await reservations.readReservationClockTime(manager);
  if (timing(a, true, now) !== "eligible")
    return { ok: false, message: "This lesson has started and can no longer be rescheduled." };
  if (timestampToEpochMicroseconds(now) >= timestampToEpochMicroseconds(scheduled.quote.startsAt)) return unavailableEdit;
  const terms = { ...operationalTerms(a, resolved.target, scheduled.quote),
    totalAmountMinor: b.total_amount_minor, pricingEvidence: b.revision.pricingEvidence };
  if (sameRevisionContract(b.revision, terms)) return { ok: true, totalAmountMinor: b.total_amount_minor };
  await writeOperationalChange(manager, a, terms, { requestKey, intentHash, actorUserId: actorId, actorScope: "coach",
    recordedAt: new Date(now) });
  return { ok: true, totalAmountMinor: b.total_amount_minor };
}

export async function rescheduleLessonAsCoachCommand(edit: Edit, actorId: string): Promise<BookingRescheduleResult> {
  return withBooking<BookingRescheduleResult>(edit.id, true, { ok: false, message: "This lesson is no longer available to reschedule." },
    (manager, a) => executeCoachReschedule(manager, a, edit, actorId),
    { booking: edit.expectedRevisionId, reservation: edit.expectedUpdatedAt }, true, { date: edit.date },
    (result) => edit.save && result.ok);
}

// changed: the booking's placement was changed by this operation. A refund-backed change is
// recorded as a pending adjustment instead (adjustmentStatus "pending", refundIds); the
// booking stays unchanged until every refund is verified. financial: the consequence,
// recomputed under the locks, that a save must accept (financialAcceptance).
export type OperationalChangeResult =
  | { ok: true; changed: boolean; totalAmountMinor: number; revisionId: string; financial?: OperationalFinancialQuote;
    adjustmentId?: string; adjustmentStatus?: BookingAdjustmentEntity["status"]; refundIds?: string[] }
  | { ok: false; reason: OperationalRejection; financial?: OperationalFinancialQuote };

// Obligations whose provider outcome is not yet known or failed: no further refund is
// allocated beside them until they are resolved.
const unresolvedRefundStatuses = new Set(["pending", "pending_retry", "failed"]);

// An exact replay of an operation recorded as a change request (a refund-backed change,
// pending or decided) reports that request; a different intent never reuses its key.
async function operationalRequestReplay(manager: EntityManager, a: Aggregate, requestKey: string,
  intentHash: string): Promise<OperationalChangeResult | null> {
  const request = await adjustments.findAdjustmentRequest(manager, a.booking.id, requestKey);
  if (!request) return null;
  if (request.target.intentHash !== intentHash) return { ok: false, reason: "operation_key_reused" };
  return { ok: true, changed: false, totalAmountMinor: a.booking.total_amount_minor, revisionId: a.booking.current_revision_id,
    adjustmentId: request.id, adjustmentStatus: request.status,
    refundIds: (await adjustments.listAdjustmentRefunds(manager, request.id)).map(refund => refund.id) };
}

// Staff operational change (Admin court and coaching bookings; a Coach's assigned lesson):
// date, start, court, location and, for a lesson, coach. Program, duration and participants
// are the booking's own. The destination is priced by the authoritative scheduling quote and
// compared with the agreed obligation (operationalFinancialQuote): an equal price or a club-
// absorbed increase keeps the agreed obligation and its pricing evidence; a reduction lowers
// it, returning collected funds above it through the refund-backed change workflow. Any
// consequence must be explicitly accepted as quoted. Not exposed by any Server Action.
async function executeOperationalChange(manager: EntityManager, a: Aggregate, input: OperationalChangeInput, actorId: string,
  capacity: OperationalCapacity): Promise<OperationalChangeResult> {
  if (await readClubTimezoneError(manager)) return { ok: false, reason: "timezone" };
  const intentHash = createHash("sha256").update(JSON.stringify({ scope: "operational", capacity, actorId,
    base: input.expectedRevisionId, locationId: input.locationId.toLowerCase(), courtId: input.courtId.toLowerCase(), date: input.date,
    start: input.startMinute, coach: input.coachUserId?.toLowerCase() ?? null, override: input.overrideCoachRestrictions })).digest("hex");
  const requestKey = input.requestId ?? intentHash;
  const eligible = await operationalEligibility(manager, a, capacity, actorId);
  if (!eligible.ok) {
    // The pending change may be this very request, still waiting for its refund.
    if (eligible.reason === "change_pending" && input.save) return await operationalRequestReplay(manager, a, requestKey, intentHash) ?? eligible;
    return eligible;
  }
  const b = a.booking;
  if (input.save) {
    const applied = await revisions.findRevisionOperation(manager, b.id, requestKey);
    if (applied) return applied.intentHash === intentHash
      ? { ok: true, changed: true, totalAmountMinor: applied.totalAmountMinor, revisionId: applied.id }
      : { ok: false, reason: "operation_key_reused" };
    const requested = await operationalRequestReplay(manager, a, requestKey, intentHash);
    if (requested) return requested;
  }
  if (!b.token_matches || !a.reservation.token_matches) return { ok: false, reason: "stale" };
  if (timing(a, true, await reservations.readReservationClockTime(manager)) !== "eligible") return { ok: false, reason: "started" };
  const resolved = await resolveOperationalTarget(manager, a, input);
  if (!resolved.ok) return resolved;
  const { target } = resolved;
  const policy = target.coach ? coachRestrictionPolicy(eligible.authorization, target.coach.userId, input.overrideCoachRestrictions) : "enforce";
  if (!policy) return { ok: false, reason: "override_denied" };
  const scheduled = await scheduleOperationalTarget(manager, a, target, policy, eligible.lesson ? eligible.lesson.coaching : null);
  if (!scheduled.ok) return scheduled;
  // The destination's terms: its placement, authoritative price and pricing evidence. A
  // lesson's evidence keeps the agreed coaching fee and its commercial provenance.
  const terms = operationalTerms(a, target, scheduled.quote);
  // A lesson keeps its agreed coaching fee and commercial provenance; a court booking its
  // agreed obligation. An unchanged placement has no financial consequence.
  const agreed = { ...terms, totalAmountMinor: b.total_amount_minor, pricingEvidence: b.revision.pricingEvidence };
  if (sameRevisionContract(b.revision, agreed))
    return { ok: true, changed: false, totalAmountMinor: b.total_amount_minor, revisionId: b.current_revision_id };
  // A coach reassignment that keeps the location, court, date and time keeps the agreed
  // obligation and evidence: current pricing configuration never reprices it.
  const placementUnchanged = terms.locationId === b.revision.locationId && terms.courtId === b.revision.courtId
    && terms.bookingDate === b.revision.bookingDate && terms.startMinute === b.revision.startMinute
    && terms.endMinute === b.revision.endMinute;
  // Read under the booking lock: verified captures and every refund obligation.
  const financials = b.payment_method === "online" && !placementUnchanged ? await bookingFinancials(manager, b.id, true) : null;
  if (financials?.captures.some(capture => capture.currency !== b.currency)) return { ok: false, reason: "financial_review_required" };
  const financial = operationalFinancialQuote({ currentAmountMinor: b.total_amount_minor,
    destinationAmountMinor: placementUnchanged ? b.total_amount_minor : scheduled.quote.totalAmountMinor,
    currency: z.enum(locationCurrencies).parse(b.currency),
    paymentMethod: b.revision.paymentMethod, refundableMinor: financials?.refundable ?? 0 });
  // Never allocate another refund while an earlier refund's outcome is unknown or failed.
  if (financial.refundMinor > 0 && financials?.refunds.some(refund => unresolvedRefundStatuses.has(refund.status)))
    return { ok: false, reason: "financial_review_required" };
  if (!input.save) return { ok: true, changed: true, totalAmountMinor: financial.customerAmountMinor,
    revisionId: b.current_revision_id, financial };
  if (!financialConsequenceAccepted(financial, input.financialAcceptance))
    return { ok: false, reason: input.financialAcceptance ? "financial_changed" : "financial_confirmation_required", financial };
  // The lock waits and target validation take time: the original start is rechecked
  // with a fresh clock reading together with the destination's, just before writing.
  const now = await reservations.readReservationClockTime(manager);
  if (timing(a, true, now) !== "eligible") return { ok: false, reason: "started" };
  if (timestampToEpochMicroseconds(now) >= timestampToEpochMicroseconds(scheduled.quote.startsAt)) return { ok: false, reason: "unavailable" };
  const operation = { requestKey, intentHash, actorUserId: actorId, actorScope: capacity, recordedAt: new Date(now) };
  const done = (revision: { id: string }, extra: Partial<Extract<OperationalChangeResult, { ok: true }>> = {}): OperationalChangeResult =>
    ({ ok: true, changed: true, totalAmountMinor: financial.customerAmountMinor, revisionId: revision.id, financial, ...extra });
  // An equal price keeps the agreed pricing evidence, never the destination's.
  if (financial.consequence === "none") return done(await writeOperationalChange(manager, a, agreed, operation));
  // The decision record of a priced change: the destination placement, its authoritative
  // price and evidence, and the obligation before and after. It is immutable evidence.
  const decision = { bookingId: b.id, baseRevisionId: b.current_revision_id, actorId, scope: "admin" as const, requestKey,
    target: { courtId: terms.courtId, date: terms.bookingDate, startMinute: terms.startMinute, endMinute: terms.endMinute,
      expectedUpdatedAt: input.expectedUpdatedAt, courtName: terms.courtName, locationName: terms.locationName, timezone: terms.timezone,
      locationId: terms.locationId, actorScope: capacity, intentHash, pricingEvidence: terms.pricingEvidence,
      destinationTotalMinor: financial.destinationAmountMinor,
      ...(terms.coachUserId && terms.coachUserId !== b.revision.coachUserId && terms.coachName
        ? { coachUserId: terms.coachUserId, coachName: terms.coachName } : {}) },
    originalTotal: financial.currentAmountMinor, newTotal: financial.customerAmountMinor, currency: b.currency, createdAt: new Date(now) };
  if (financial.consequence === "club_absorbs") {
    // The customer keeps the agreed obligation, payments and commercial provenance; the
    // applied decision records the destination price the club absorbs.
    const record = await adjustments.insertAdjustment(manager, { ...decision, expiresAt: new Date(now), status: "applied" });
    return done(await writeOperationalChange(manager, a, agreed, { ...operation, adjustmentId: record.id },
      operationalFinancialNote(financial, b.revision.paymentMethod)), { adjustmentId: record.id, adjustmentStatus: "applied" });
  }
  // No collected funds to return (club payment, or an unpaid balance): the obligation falls
  // to the destination price, explained by the destination's evidence.
  if (financial.consequence === "amount_reduced") return done(await writeOperationalChange(manager, a, terms, operation,
    operationalFinancialNote(financial, b.revision.paymentMethod)));
  // A reduction returning collected funds keeps the original booking until every refund is
  // verified; its target stays held (bounded by its start) so the change can be applied. Any
  // scheduled destination has a hold plan, so a preview that passed scheduling is never
  // refused here deterministically: only the exclusions can still reject a concurrent race.
  // A replacement coach is held over the whole target, coach-only where the original
  // reservation already occupies the court.
  const r = a.reservation, coach = decision.target.coachUserId;
  const original = { courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute };
  const placed = { courtId: terms.courtId, date: terms.bookingDate, startMinute: terms.startMinute, endMinute: terms.endMinute };
  const fragments = coach ? reassignmentHoldFragments(original, placed, coach) : adjustmentHoldFragments(original, placed, r.coach_user_id);
  const startsAt = new Date(scheduled.quote.startsAt);
  const pending = await adjustments.insertAdjustment(manager, { ...decision, expiresAt: startsAt });
  await adjustments.insertAdjustmentHolds(manager, { adjustmentId: pending.id, expiresAt: startsAt, fragments });
  const refundIds = await allocateBookingRefund(manager, { bookingId: b.id, amount: financial.refundMinor, operationKey: pending.id,
    adjustmentId: pending.id, actorId, reason: "booking_price_reduction", contextRevisionId: b.current_revision_id });
  await recordBookingChangeRefundRequested(manager, b.revision, pending, financial.refundMinor);
  return { ok: true, changed: false, totalAmountMinor: b.total_amount_minor, revisionId: b.current_revision_id, financial,
    adjustmentId: pending.id, adjustmentStatus: "pending", refundIds };
}

export async function changeBookingOperationallyCommand(input: OperationalChangeInput, actorId: string,
  capacity: OperationalCapacity): Promise<OperationalChangeResult> {
  try {
    return await withBooking<OperationalChangeResult>(input.id, true, { ok: false, reason: "unavailable" },
      (manager, a) => executeOperationalChange(manager, a, input, actorId, capacity),
      { booking: input.expectedRevisionId, reservation: input.expectedUpdatedAt }, true,
      { date: input.date, coachUserId: input.coachUserId, locationId: input.locationId },
      // Only an accepted save commits; a preview or rejection keeps every hold and payment as found.
      (result) => input.save && result.ok);
  } catch (error: unknown) {
    // The exclusions arbitrate a race the locked reads could not see; the transaction rolled back.
    const overlap = reservationOverlap(normalizeDatabaseError(error));
    if (!overlap) throw error;
    return { ok: false, reason: overlap === "court" ? "court-unavailable" : "coach-booked" };
  }
}
