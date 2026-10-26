import type { LocationCurrency } from "@/lib/pricing/money";

// One configured lesson price/person: the price each participant pays for one complete
// lesson of a program duration booked for a participant count, in one currency. A club
// default (coach null) or one coach's override. Club-wide, never per location.
export type CoachingPriceRecord = {
  programId: string;
  durationMinutes: number;
  participantCount: number;
  coachUserId: string | null;
  amountMinor: number;
  currency: LocationCurrency;
};

export type ResolvedCoachingPrice = {
  amountMinor: number;
  currency: LocationCurrency;
  source: "coach" | "club";
};

export type CoachingPriceTarget = {
  programId: string;
  durationMinutes: number;
  participantCount: number;
  // The booking location's currency. Amounts are never converted between currencies.
  currency: LocationCurrency;
  coachUserId?: string | null;
};

// Effective price: the coach's override ?? the club default, for the same program,
// duration, participant count and currency. An override wins whether higher or lower.
// Null means the lesson is unpriced and cannot proceed to payment; no other count or
// duration is consulted. Uniqueness is a database constraint; ambiguity throws.
export function resolveCoachingPrice(prices: readonly CoachingPriceRecord[], target: CoachingPriceTarget): ResolvedCoachingPrice | null {
  const key = (id: string | null) => id === null ? null : id.toLowerCase();
  const candidates = prices.filter((price) => key(price.programId) === key(target.programId)
    && price.durationMinutes === target.durationMinutes && price.participantCount === target.participantCount
    && price.currency === target.currency);
  const pick = (coachUserId: string | null) => {
    const matches = candidates.filter((price) => key(price.coachUserId) === key(coachUserId));
    if (matches.length > 1) throw new Error("Ambiguous coaching price configuration.");
    return matches[0];
  };
  const override = target.coachUserId ? pick(target.coachUserId) : undefined;
  const price = override ?? pick(null);
  return price ? { amountMinor: price.amountMinor, currency: price.currency, source: override ? "coach" : "club" } : null;
}

export type CoachingFromPrice = { currency: LocationCurrency; amountMinor: number };

// The lowest amount per currency, in currency order. Amounts of different currencies
// are never compared with each other.
export function lowestPricesByCurrency(amounts: Iterable<CoachingFromPrice>): CoachingFromPrice[] {
  const lowest = new Map<LocationCurrency, number>();
  for (const { currency, amountMinor } of amounts) {
    const current = lowest.get(currency);
    if (current === undefined || amountMinor < current) lowest.set(currency, amountMinor);
  }
  return [...lowest].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

// The only coaching amount calculation: the lesson total of the price/person resolved for
// exactly this program, duration and participant count. Nothing scales by duration.
export function coachingLessonAmount(pricePerPersonMinor: number, participantCount: number) {
  return pricePerPersonMinor * participantCount;
}
