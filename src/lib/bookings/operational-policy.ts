import { z } from "zod";
import { locationCurrencies } from "@/lib/pricing/currency";

// Staff (Admin or Coach) operational management of an existing booking: who may
// change or cancel which booking, and which configurable Coach restrictions a change
// may override. Pure policy: the caller supplies the actor's account/role facts and
// the booking's assignment as read under the booking's locks, so a revoked role, a
// suspended account or a reassignment committed before the locks is always observed.

// The operation's own permission set. An Admin+Coach account acts with the
// permissions of the operation it performs, never their union.
export type OperationalCapacity = "admin" | "coach";

export type OperationalActorFacts = { status: "active" | "suspended"; roles: readonly string[] } | null;

// assignedCoachUserId: the coach currently assigned by both the booking's current
// revision and its reservation, or null (a court booking or inconsistent facts).
export type OperationalBookingFacts = { kind: "court" | "coaching"; assignedCoachUserId: string | null };

export type OperationalAuthorization = { ok: true; capacity: OperationalCapacity; actorUserId: string } | { ok: false };

export function authorizeOperationalChange(capacity: OperationalCapacity, actorUserId: string,
  actor: OperationalActorFacts, booking: OperationalBookingFacts): OperationalAuthorization {
  if (actor?.status !== "active") return { ok: false };
  // Admin authority is independent of any coach assignment.
  if (capacity === "admin") return actor.roles.includes("admin") ? { ok: true, capacity, actorUserId } : { ok: false };
  // A Coach manages only coaching lessons currently assigned to them; after a
  // reassignment the former Coach loses, and the new Coach gains, that permission.
  if (!actor.roles.includes("coach") || booking.kind !== "coaching"
    || booking.assignedCoachUserId?.toLowerCase() !== actorUserId.toLowerCase()) return { ok: false };
  return { ok: true, capacity, actorUserId };
}

// Configurable Coach restrictions are weekly working hours, time off and location
// assignment. An Admin may override any Coach's; a Coach only their own. Program
// compatibility never limits an operational change, and court and Coach occupancy
// (including live and payment-protected holds) are never overridable.
function mayOverrideCoachRestrictions(authorization: Extract<OperationalAuthorization, { ok: true }>, coachUserId: string) {
  return authorization.capacity === "admin" || coachUserId.toLowerCase() === authorization.actorUserId.toLowerCase();
}

export type CoachRestrictionPolicy = "enforce" | "override";

// The restriction policy applied to the destination coach, or null when the
// requested override is not permitted for this actor and coach.
export function coachRestrictionPolicy(authorization: Extract<OperationalAuthorization, { ok: true }>, coachUserId: string,
  overrideRequested: boolean): CoachRestrictionPolicy | null {
  if (!overrideRequested) return "enforce";
  return mayOverrideCoachRestrictions(authorization, coachUserId) ? "override" : null;
}

// The financial consequence of a staff change, decided only from server-side facts: the
// booking's current agreed obligation, the destination's authoritative price and, for an
// online booking, its verified collected funds not yet reserved by any refund obligation.
// A staff change never raises the customer's obligation: a dearer destination is absorbed
// by the club, a cheaper one lowers the obligation and returns only collected funds above
// it. Because the obligation can only fall, a later move never reinstates a waived amount.
const operationalFinancialConsequences = ["none", "club_absorbs", "refund", "amount_reduced"] as const;

const minorAmount = z.number().int().min(0).max(2147483647);
const operationalFinancialQuoteSchema = z.strictObject({
  consequence: z.enum(operationalFinancialConsequences),
  currency: z.enum(locationCurrencies),
  // The agreed obligation before the change, the destination's applicable price and the
  // obligation after it; refund and absorbed amounts explain the difference.
  currentAmountMinor: minorAmount, destinationAmountMinor: minorAmount, customerAmountMinor: minorAmount,
  refundMinor: minorAmount, absorbedMinor: minorAmount,
});
export type OperationalFinancialQuote = z.infer<typeof operationalFinancialQuoteSchema>;

export function operationalFinancialQuote(input: { currentAmountMinor: number; destinationAmountMinor: number;
  currency: OperationalFinancialQuote["currency"]; paymentMethod: "online" | "pay_at_club"; refundableMinor: number }): OperationalFinancialQuote {
  const { currentAmountMinor: current, destinationAmountMinor: destination, currency } = input;
  const base = { currency, currentAmountMinor: current, destinationAmountMinor: destination };
  if (destination === current) return { ...base, consequence: "none", customerAmountMinor: current, refundMinor: 0, absorbedMinor: 0 };
  if (destination > current) return { ...base, consequence: "club_absorbs", customerAmountMinor: current, refundMinor: 0,
    absorbedMinor: destination - current };
  // Collected funds above the new obligation are returned, never more than the reduction;
  // money that was not collected (club payment, an unpaid balance) is never refunded.
  const refundMinor = input.paymentMethod === "online"
    ? Math.min(current - destination, Math.max(0, input.refundableMinor - destination)) : 0;
  return { ...base, consequence: refundMinor > 0 ? "refund" : "amount_reduced", customerAmountMinor: destination, refundMinor, absorbedMinor: 0 };
}

// A consequence other than "none" must be accepted exactly as quoted; any accepted quote
// must still match, so a changed price or balance never applies silently.
export function financialConsequenceAccepted(quote: OperationalFinancialQuote, accepted: OperationalFinancialQuote | undefined) {
  if (!accepted) return quote.consequence === "none";
  return (Object.keys(quote) as (keyof OperationalFinancialQuote)[]).every((key) => quote[key] === accepted[key]);
}

// The requested destination of an operational change. Every identifier is untrusted:
// relationships (court ∈ location, coach eligibility) are resolved from persisted
// configuration under lock. Program, duration and participant count are never
// requested; they are the booking's own fixed terms.
export const operationalChangeInputSchema = z.strictObject({
  id: z.uuid(), expectedRevisionId: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
  locationId: z.uuid(), courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1410).multipleOf(30),
  // A coaching lesson's destination coach; omitted keeps the assigned coach. Never valid for a court booking.
  coachUserId: z.uuid().optional(),
  overrideCoachRestrictions: z.boolean(),
  requestId: z.uuid().optional(), save: z.boolean(),
  // The quoted financial consequence the actor explicitly accepted; recomputed and
  // compared on save, never used as an amount.
  financialAcceptance: operationalFinancialQuoteSchema.optional(),
});
export type OperationalChangeInput = z.infer<typeof operationalChangeInputSchema>;

export type OperationalRejection = "unavailable" | "stale" | "invalid_target" | "cross_currency" | "inactive_original"
  | "change_pending" | "started" | "timezone" | "override_denied" | "coach_ineligible" | "invalid-time"
  | "coach-unavailable" | "coach-booked" | "court-unavailable" | "unpriced" | "operation_key_reused"
  // financial_review_required: an unresolved balance (another currency's captures or an
  // unresolved refund) needs Admin review first; financial_confirmation_required: the
  // consequence was not accepted; financial_changed: the accepted quote no longer applies.
  | "financial_review_required" | "financial_confirmation_required" | "financial_changed";
