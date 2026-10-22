import type { LocationCurrency } from "@/lib/pricing/money";

// One configured amount for a program duration in one currency: a club default
// (coach null) or one coach's override. Prices are club-wide, never per location.
export type CoachingPriceRecord = {
  programId: string;
  durationMinutes: number;
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
  // The booking location's currency. Amounts are never converted between currencies.
  currency: LocationCurrency;
  coachUserId?: string | null;
};

// Effective price: the coach's override ?? the club default, for the same program,
// duration and currency. An override wins whether higher or lower. Null means the
// lesson is unpriced and cannot proceed to payment. Uniqueness is a database
// constraint; ambiguity throws.
export function resolveCoachingPrice(prices: readonly CoachingPriceRecord[], target: CoachingPriceTarget): ResolvedCoachingPrice | null {
  const key = (id: string | null) => id === null ? null : id.toLowerCase();
  const candidates = prices.filter((price) => key(price.programId) === key(target.programId)
    && price.durationMinutes === target.durationMinutes && price.currency === target.currency);
  const pick = (coachUserId: string | null) => {
    const matches = candidates.filter((price) => key(price.coachUserId) === key(coachUserId));
    if (matches.length > 1) throw new Error("Ambiguous coaching price configuration.");
    return matches[0];
  };
  const override = target.coachUserId ? pick(target.coachUserId) : undefined;
  const price = override ?? pick(null);
  return price ? { amountMinor: price.amountMinor, currency: price.currency, source: override ? "coach" : "club" } : null;
}
