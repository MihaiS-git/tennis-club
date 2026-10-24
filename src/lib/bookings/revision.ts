import { z } from "zod";
import type { PricingRule } from "@/lib/pricing/validation";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { resolvePricingRule } from "@/lib/pricing/resolution";
import { participantCountSchema } from "@/lib/coaching/validation";

type RevisionKind = "created" | "confirmed" | "rescheduled" | "cancelled";
type RevisionScope = "guest" | "customer" | "coach_owner" | "admin_owner" | "admin" | "provider";
const currencySchema = z.enum(["EUR", "USD", "GBP", "RON", "CHF"]);
// The coaching price agreed for a lesson: the resolved coach override or club
// default, and the court rental it adds (zero when the program includes it).
// The slots still explain the court's rental value, charged or not.
const coachingEvidenceSchema = z.strictObject({
  // The count the lesson was booked for, within its program's range then. Older private contracts predate this snapshot.
  participantCount: participantCountSchema.optional(),
  programId: z.uuid(), coachUserId: z.uuid(), locationId: z.uuid(), durationMinutes: z.number().int().min(60).max(1440),
  source: z.enum(["coach", "club"]), amountMinor: z.number().int().positive().max(2147483647), currency: currencySchema,
  courtRentalIncluded: z.boolean(), courtRentalMinor: z.number().int().positive().max(2147483647),
  courtAmountMinor: z.number().int().min(0).max(2147483647),
});
export const pricingEvidenceSchema = z.strictObject({
  version: z.literal(1), rounding: z.literal("half-hour-sum-round"),
  courtState: z.enum(["outdoor", "covered", "indoor"]),
  slots: z.array(z.strictObject({ minute: z.number().int().min(0).max(1410), ruleId: z.uuid(),
    ruleSetId: z.uuid(), hourlyMinor: z.number().int().positive(), startsOn: z.iso.date().nullable(), endsOn: z.iso.date().nullable() })).min(2).max(48),
  coaching: coachingEvidenceSchema.optional(),
});
export type PricingEvidence = z.infer<typeof pricingEvidenceSchema>;
const revisionTermsSchema = z.object({
  locationId: z.uuid(), courtId: z.uuid(), locationName: z.string().min(1).max(255), courtName: z.string().min(1).max(255),
  timezone: z.string().min(1).max(100), bookingDate: z.iso.date(), startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440), customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().trim().min(1).max(320), customerPhone: z.string().trim().min(1).max(50),
  totalAmountMinor: z.number().int().positive().max(2147483647), currency: currencySchema,
  paymentMethod: z.enum(["online", "pay_at_club"]), cancellationNoticeMinutes: z.number().int().min(0).max(43200),
  pricingEvidence: pricingEvidenceSchema,
  // A coaching contract names its coach and program with historical names; a court booking names neither.
  coachUserId: z.uuid().nullable().optional(), coachingProgramId: z.uuid().nullable().optional(),
  coachName: z.string().trim().min(1).max(100).nullable().optional(),
  coachingProgramName: z.string().trim().min(1).max(100).nullable().optional(),
}).refine(t => t.startMinute % 30 === 0 && t.endMinute % 30 === 0 && t.endMinute - t.startMinute >= 60)
  .refine(t => {
    const coaching = t.pricingEvidence.coaching;
    const named = [t.coachUserId, t.coachingProgramId, t.coachName, t.coachingProgramName];
    if (!coaching) return named.every(value => value == null);
    return named.every(value => value != null) && t.coachUserId === coaching.coachUserId
      && t.coachingProgramId === coaching.programId && t.locationId === coaching.locationId
      && t.endMinute - t.startMinute === coaching.durationMinutes && t.currency === coaching.currency
      && coaching.courtAmountMinor === (coaching.courtRentalIncluded ? 0 : coaching.courtRentalMinor)
      && t.totalAmountMinor === coaching.amountMinor + coaching.courtAmountMinor;
  }, "Coaching terms must match their pricing evidence");
export type RevisionTerms = z.infer<typeof revisionTermsSchema>;
export type RevisionSnapshot = RevisionTerms & {
  id: string; bookingId: string; revisionNumber: number; previousRevisionId: string | null;
  operationKey: string; intentHash: string; kind: RevisionKind;
  bookingState: "pending_payment" | "confirmed" | "cancelled";
  actorUserId: string | null; actorScope: RevisionScope; recordedAt: Date;
  adjustmentId: string | null; cancellationCause: "owner_cancelled" | "admin_cancelled" | "checkout_abandoned" | null;
};

// Captures the rule facts already used by the authoritative quote. No live pricing FK:
// configuration replacement must not erase contractual evidence.
export type CoachingEvidence = z.infer<typeof coachingEvidenceSchema>;

// A lesson's revision evidence: the court slots behind its rental value and the
// agreed coaching terms. The rental is charged unless the program includes it.
export function lessonPricingEvidence(courtPricing: PricingEvidence,
  coaching: Omit<CoachingEvidence, "courtRentalMinor" | "courtAmountMinor">, courtRentalMinor: number): PricingEvidence {
  return { ...courtPricing, coaching: { ...coaching, courtRentalMinor,
    courtAmountMinor: coaching.courtRentalIncluded ? 0 : courtRentalMinor } };
}

export function capturePricingEvidence(rules: readonly PricingRule[], terms: {
  courtId: string; courtState: PricingEvidence["courtState"]; date: string; startMinute: number; endMinute: number; total: number;
}): PricingEvidence {
  const slots = Array.from({ length: (terms.endMinute - terms.startMinute) / 30 }, (_, index) => {
    const minute = terms.startMinute + index * 30;
    const rule = resolvePricingRule(rules, { court_id: terms.courtId, court_state: terms.courtState, date: terms.date, minute });
    if (!rule || rule.ends_at_minute < minute + 30) throw new Error("Incomplete revision pricing evidence");
    return { minute, ruleId: rule.id, ruleSetId: rule.rule_set_id, hourlyMinor: rule.price_per_hour_minor,
      startsOn: rule.starts_on, endsOn: rule.ends_on };
  });
  const quote = getCalendarSelection({ courtId: terms.courtId, times: slots.map(s => s.minute),
    cells: slots.map(() => "available"), hourlyPrices: slots.map(s => s.hourlyMinor) }, 0, slots.length);
  if (quote?.priceMinor !== terms.total)
    throw new Error("Revision evidence does not explain the quote");
  return pricingEvidenceSchema.parse({ version: 1, rounding: "half-hour-sum-round", courtState: terms.courtState, slots });
}
export function buildBookingRevision(terms: RevisionTerms, operation: Omit<RevisionSnapshot, keyof RevisionTerms | "revisionNumber" | "previousRevisionId">,
  previous: { id: string; bookingId: string; revisionNumber: number } | null): RevisionSnapshot {
  if (previous && previous.bookingId !== operation.bookingId) throw new Error("Cross-booking revision predecessor");
  return { ...revisionTermsSchema.parse(terms), ...operation, previousRevisionId: previous?.id ?? null,
    revisionNumber: (previous?.revisionNumber ?? 0) + 1 };
}
export function sameRevisionContract(left: RevisionTerms, right: RevisionTerms): boolean {
  // Display names and evidence explain the contract; a configuration rename alone
  // is not a customer-requested commercial change.
  return left.locationId === right.locationId && left.courtId === right.courtId && left.timezone === right.timezone
    && left.bookingDate === right.bookingDate && left.startMinute === right.startMinute && left.endMinute === right.endMinute
    && left.customerName === right.customerName && left.customerEmail === right.customerEmail && left.customerPhone === right.customerPhone
    && left.totalAmountMinor === right.totalAmountMinor && left.currency === right.currency && left.paymentMethod === right.paymentMethod
    && left.cancellationNoticeMinutes === right.cancellationNoticeMinutes;
}
