import "server-only";

import type { EntityManager } from "typeorm";
import { toCalendarCoveragePeriod, toCalendarPricingRule } from "@/lib/courts/calendar-projections";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { readIndependently } from "@/lib/db/transaction";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { listBookingEditDayCoverage, listCheckoutLocationCourts } from "@/lib/db/repositories/clubs.repository";
import { listCoachDayAvailability } from "@/lib/db/repositories/coach-availability.repository";
import { findCoachProfile } from "@/lib/db/repositories/coaching.repository";
import { listBookingEditDayPricing } from "@/lib/db/repositories/pricing.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as revisions from "@/lib/db/repositories/booking-revisions.repository";
import { operationalSchedule, quoteCoachingReschedule, type CoachingLessonDay, type OperationalDay } from "@/lib/coaching/lesson-quote";
import { recordBookingTransition } from "@/lib/notifications/events";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { randomUUID } from "node:crypto";
import type { BookingAggregate } from "./commands";
import type { CoachRestrictionPolicy, OperationalBookingFacts, OperationalChangeInput, OperationalRejection } from "./operational-policy";
import { buildBookingRevision, type CoachingEvidence, type PricingEvidence, type RevisionTerms } from "./revision";

// Shared staff operational scheduling of an existing booking (Admin court and coaching
// bookings; a Coach's assigned lessons). Callers own the transaction, the booking's
// locks (withBooking: configuration → coach profiles → ordered locations → booking →
// reservation) and authorization; nothing here starts a transaction or calls a provider.

const maxAmountMinor = 2147483647;

// The coach currently assigned by both the current revision and the reservation.
export function operationalBookingFacts(a: BookingAggregate): OperationalBookingFacts {
  const v = a.booking.revision;
  const lesson = !!v.pricingEvidence.coaching || !!v.coachUserId || !!a.reservation.coach_user_id;
  return { kind: lesson ? "coaching" : "court", assignedCoachUserId: v.pricingEvidence.coaching && v.coachUserId
    && v.coachUserId === a.reservation.coach_user_id ? v.coachUserId : null };
}

// A coaching booking's fixed lesson: its revision names the program and current coach,
// its evidence the agreed fee, duration and commercial provenance, and its reservation
// holds the same coach at the revision's location. null for a court booking; false
// when the facts disagree. The evidence's coach and location are where the price was
// agreed, which an operational reassignment never rewrites.
export function lessonContract(a: BookingAggregate) {
  const v = a.booking.revision, coaching = v.pricingEvidence.coaching;
  if (!coaching && !v.coachUserId && !a.reservation.coach_user_id) return null;
  if (!coaching || !v.coachUserId || !v.coachingProgramId || a.reservation.coach_user_id !== v.coachUserId
    || coaching.programId !== v.coachingProgramId || v.locationId !== a.location.id
    || a.reservation.ends_at_minute - a.reservation.starts_at_minute !== coaching.durationMinutes
    || v.paymentMethod !== "online") return false;
  return { coachUserId: v.coachUserId, programId: v.coachingProgramId, coaching };
}

type Location = BookingAggregate["location"];

// One local date at one location from the operational (non-public) configuration:
// active courts, effective opening hours, coverage, pricing and live occupancy
// excluding the booking's own reservation; for a lesson, the destination coach's
// schedule and occupancy at every location. Location publication and public coach
// or program visibility are not required.
export async function readOperationalDay(manager: EntityManager, location: Location, coachUserId: string | null, date: string,
  excludeReservationId: string, now: Date): Promise<OperationalDay> {
  const courts = await listCheckoutLocationCourts(manager, location.id);
  const courtIds = courts.map((court) => court.id);
  const [hours, coverage, pricing, occupancy, schedule, coachOccupancy] = await readIndependently(manager, [
    () => reservations.listReservationOpeningHours(manager, location.id, date),
    () => listBookingEditDayCoverage(manager, location.id, courtIds, date),
    () => listBookingEditDayPricing(manager, location.id, courtIds, mondayWeekday(date), date),
    () => reservations.listCustomerEditOccupancy(manager, location.id, date, excludeReservationId),
    async () => coachUserId ? listCoachDayAvailability(manager, coachUserId, date) : null,
    async () => coachUserId ? reservations.listCoachDayOccupancy(manager, coachUserId, date, excludeReservationId) : null,
  ]);
  return {
    location: { id: location.id, name: location.name, timezone: location.timezone, currency: location.currency,
      courts: courts.map((court) => ({ id: court.id, name: court.name, slug: court.slug, surface: court.surface,
        environment: court.environment, has_lighting: court.hasLighting })) },
    date, today: localToday(location.timezone, now), currentMinute: localMinute(location.timezone, now),
    hours, coverage: coverage.map(toCalendarCoveragePeriod), pricing: pricing.map(toCalendarPricingRule),
    courtOccupancy: occupancy.map((row) => ({ ...row, booking_date: date })),
    coach: coachUserId && schedule && coachOccupancy
      ? { userId: coachUserId.toLowerCase(), weekly: schedule.weekly, exceptions: schedule.exceptions, occupancy: coachOccupancy } : null,
  };
}

export async function readOperationalLessonDay(manager: EntityManager, location: Location, coachUserId: string, date: string,
  excludeReservationId: string, now: Date): Promise<Omit<CoachingLessonDay, "coaching">> {
  const day = await readOperationalDay(manager, location, coachUserId, date, excludeReservationId, now);
  if (!day.coach) throw new Error("Malformed lesson day.");
  return { ...day, coach: day.coach };
}

export type OperationalTarget = {
  location: Location; courtId: string; date: string; startMinute: number; endMinute: number;
  // A lesson's destination coach; locationAssigned is the configurable location assignment.
  coach: { userId: string; name: string; locationAssigned: boolean } | null;
};
type Rejected = { ok: false; reason: OperationalRejection };

// Resolves the requested destination from persisted configuration under the booking's
// locks: the location must be one this transaction locked, active and unarchived, in the
// booking's currency; the court an active court of that location; the duration (and, for
// a lesson, program and participants) the booking's own. A lesson's destination coach
// needs an active account, the Coach role and an unarchived profile; a court booking
// never names a coach. Forged or contradictory combinations are rejected.
export async function resolveOperationalTarget(manager: EntityManager, a: BookingAggregate,
  input: Pick<OperationalChangeInput, "locationId" | "courtId" | "date" | "startMinute" | "coachUserId">,
): Promise<{ ok: true; target: OperationalTarget } | Rejected> {
  const lesson = lessonContract(a);
  if (lesson === false) return { ok: false, reason: "unavailable" };
  const location = a.locations.find((candidate) => candidate.id === input.locationId.toLowerCase());
  if (!location || !location.isActive || location.archivedAt !== null) return { ok: false, reason: "invalid_target" };
  if (location.currency !== a.booking.currency) return { ok: false, reason: "cross_currency" };
  const court = (await listCheckoutLocationCourts(manager, location.id)).find((candidate) => candidate.id === input.courtId.toLowerCase());
  if (!court) return { ok: false, reason: "invalid_target" };
  const endMinute = input.startMinute + a.reservation.ends_at_minute - a.reservation.starts_at_minute;
  if (endMinute > 1440) return { ok: false, reason: "invalid-time" };
  const target = { location, courtId: court.id, date: input.date, startMinute: input.startMinute, endMinute };
  if (!lesson) return input.coachUserId ? { ok: false, reason: "invalid_target" } : { ok: true, target: { ...target, coach: null } };
  const coachUserId = (input.coachUserId ?? lesson.coachUserId).toLowerCase();
  // Shares the destination coach's role/account rows, so a concurrent revocation serializes.
  const facts = await lockReservationActorFacts(manager, coachUserId);
  const profile = await findCoachProfile(manager, coachUserId);
  if (facts?.status !== "active" || !facts.roles.includes("coach") || !profile) return { ok: false, reason: "coach_ineligible" };
  return { ok: true, target: { ...target, coach: { userId: coachUserId, name: profile.displayName,
    locationAssigned: profile.locationIds.includes(location.id) } } };
}

export type OperationalQuote = {
  court: { id: string; name: string }; startMinute: number; endMinute: number; startsAt: string;
  // The destination's applicable price: a lesson's agreed coaching fee plus the destination
  // court component, or a court booking's destination rental. The staff financial policy
  // compares it with the agreed obligation; it is never charged.
  totalAmountMinor: number; pricingEvidence: PricingEvidence;
};

// Validates the destination with the shared scheduling rules. policy is the coach-window
// policy the caller's authorization permits; court and coach occupancy always apply.
export async function scheduleOperationalTarget(manager: EntityManager, a: BookingAggregate, target: OperationalTarget,
  policy: CoachRestrictionPolicy, coaching: CoachingEvidence | null): Promise<{ ok: true; quote: OperationalQuote } | Rejected> {
  if (target.coach && policy === "enforce" && !target.coach.locationAssigned) return { ok: false, reason: "coach-unavailable" };
  const now = new Date(await reservations.readReservationClockTime(manager));
  if (target.coach && coaching) {
    const day = await readOperationalLessonDay(manager, target.location, target.coach.userId, target.date, a.reservation.id, now);
    if (target.date < day.today) return { ok: false, reason: "unavailable" };
    const quoted = quoteCoachingReschedule(day, coaching, { courtId: target.courtId, startMinute: target.startMinute }, policy);
    return quoted.ok ? { ok: true, quote: quoted.quote } : quoted;
  }
  const day = await readOperationalDay(manager, target.location, null, target.date, a.reservation.id, now);
  if (target.date < day.today) return { ok: false, reason: "unavailable" };
  const scheduled = operationalSchedule(day)({ courtId: target.courtId, startMinute: target.startMinute, endMinute: target.endMinute });
  if (!scheduled.ok) return scheduled;
  const { slot } = scheduled;
  if (slot.courtRentalMinor > maxAmountMinor) return { ok: false, reason: "unpriced" };
  return { ok: true, quote: { court: slot.court, startMinute: slot.startMinute, endMinute: slot.endMinute, startsAt: slot.startsAt,
    totalAmountMinor: slot.courtRentalMinor, pricingEvidence: slot.courtPricing } };
}

// The destination's revision terms. Customer, payment method, cancellation notice,
// program, participants and the coaching evidence's provenance are carried unchanged;
// the location, court, schedule and coach become the new operational assignment.
export function operationalTerms(a: BookingAggregate, target: OperationalTarget, quote: OperationalQuote): RevisionTerms {
  return { ...a.booking.revision, locationId: target.location.id, locationName: target.location.name, timezone: target.location.timezone,
    courtId: quote.court.id, courtName: quote.court.name, bookingDate: target.date, startMinute: quote.startMinute, endMinute: quote.endMinute,
    // A reassignment names the destination coach; the same coach keeps the recorded name.
    ...(target.coach && target.coach.userId !== a.booking.revision.coachUserId?.toLowerCase()
      ? { coachUserId: target.coach.userId, coachName: target.coach.name } : {}),
    totalAmountMinor: quote.totalAmountMinor, pricingEvidence: quote.pricingEvidence };
}

// Appends the change atomically: the reservation (court, schedule and coach, arbitrated by
// both exclusions), the immutable revision with its pointer fence, and the completed-change
// notifications under the existing recipient policy. Any failure throws and rolls back.
// adjustmentId links the applied financial decision the revision carries out; note states
// its financial outcome to the customer.
export async function writeOperationalChange(manager: EntityManager, a: BookingAggregate, terms: RevisionTerms, operation: {
  requestKey: string; intentHash: string; actorUserId: string; actorScope: "admin" | "coach"; recordedAt: Date; adjustmentId?: string;
}, note?: string) {
  const revision = buildBookingRevision(terms, { id: randomUUID(), bookingId: a.booking.id, kind: "rescheduled", bookingState: "confirmed",
    operationKey: operation.requestKey, intentHash: operation.intentHash, actorUserId: operation.actorUserId,
    actorScope: operation.actorScope, recordedAt: operation.recordedAt, adjustmentId: operation.adjustmentId ?? null,
    cancellationCause: null }, a.booking.revision);
  if (!await reservations.updateReservationAssignment(manager, a.reservation.id, { courtId: revision.courtId, date: revision.bookingDate,
    startMinute: revision.startMinute, endMinute: revision.endMinute, coachUserId: revision.coachUserId ?? null }))
    throw new revisions.BookingRevisionFenceError("Reservation change was not persisted");
  await revisions.advanceRevision(manager, { revision, previousId: a.booking.current_revision_id, status: "confirmed" });
  await recordBookingTransition(manager, revision, note, a.booking.revision);
  return revision;
}
