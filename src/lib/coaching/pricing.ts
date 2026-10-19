import type { LocationCurrency } from "@/lib/pricing/money";

// One configured amount: a club default (coach null) or one coach's override,
// for a program duration at one location, in the currency it was entered in.
export type CoachingPriceRecord = {
  programId: string;
  durationMinutes: number;
  locationId: string;
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
  locationId: string;
  // The location's current currency. Amounts entered in another currency are
  // never re-denominated; they stay unavailable until an Admin re-enters them.
  locationCurrency: LocationCurrency;
  coachUserId?: string | null;
};

export function isCurrentCoachingPrice(price: Pick<CoachingPriceRecord, "currency">, locationCurrency: LocationCurrency) {
  return price.currency === locationCurrency;
}

// A coach's override wins over the club default. An override that exists but
// no longer matches the location currency resolves to null rather than silently
// falling back to the club default, so a coach is never shown a price the Admin
// did not set for them. Uniqueness is a database constraint; ambiguity throws.
export function resolveCoachingPrice(prices: readonly CoachingPriceRecord[], target: CoachingPriceTarget): ResolvedCoachingPrice | null {
  const key = (id: string) => id.toLowerCase();
  const candidates = prices.filter((price) => key(price.programId) === key(target.programId)
    && price.durationMinutes === target.durationMinutes && key(price.locationId) === key(target.locationId));
  const pick = (coachUserId: string | null) => {
    const matches = candidates.filter((price) => (price.coachUserId === null ? null : key(price.coachUserId)) === (coachUserId === null ? null : key(coachUserId)));
    if (matches.length > 1) throw new Error("Ambiguous coaching price configuration.");
    return matches[0];
  };
  const resolved = (price: CoachingPriceRecord, source: ResolvedCoachingPrice["source"]) =>
    isCurrentCoachingPrice(price, target.locationCurrency) ? { amountMinor: price.amountMinor, currency: price.currency, source } : null;
  if (target.coachUserId) {
    const override = pick(target.coachUserId);
    if (override) return resolved(override, "coach");
  }
  const fallback = pick(null);
  return fallback ? resolved(fallback, "club") : null;
}
