import { describe, expect, it } from "vitest";
import { resolveCoachingPrice, type CoachingPriceRecord } from "@/lib/coaching/pricing";

const program = "a1000000-0000-4000-8000-000000000001";
const east = "b1000000-0000-4000-8000-000000000001";
const west = "b1000000-0000-4000-8000-000000000002";
const coachA = "c1000000-0000-4000-8000-00000000000a";
const coachB = "c1000000-0000-4000-8000-00000000000b";
const coachC = "c1000000-0000-4000-8000-00000000000c";

const price = (overrides: Partial<CoachingPriceRecord>): CoachingPriceRecord => ({
  programId: program, durationMinutes: 60, locationId: east, coachUserId: null, amountMinor: 12000, currency: "RON", ...overrides,
});
const prices = [
  price({}),
  price({ coachUserId: coachB, amountMinor: 15000 }),
  price({ coachUserId: coachC, amountMinor: 18000 }),
  price({ durationMinutes: 90, amountMinor: 17000 }),
  price({ locationId: west, amountMinor: 3000, currency: "EUR" }),
];
const target = { programId: program, durationMinutes: 60, locationId: east, locationCurrency: "RON" as const };

describe("resolveCoachingPrice", () => {
  it("uses the club default when no coach or no override applies", () => {
    expect(resolveCoachingPrice(prices, target)).toEqual({ amountMinor: 12000, currency: "RON", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachA })).toEqual({ amountMinor: 12000, currency: "RON", source: "club" });
  });

  it("prefers each coach's own override", () => {
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachB })).toEqual({ amountMinor: 15000, currency: "RON", source: "coach" });
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachC.toUpperCase() })).toEqual({ amountMinor: 18000, currency: "RON", source: "coach" });
  });

  it("keeps durations and locations, with their own currency, separate", () => {
    expect(resolveCoachingPrice(prices, { ...target, durationMinutes: 90, coachUserId: coachB })).toEqual({ amountMinor: 17000, currency: "RON", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, locationId: west, locationCurrency: "EUR" })).toEqual({ amountMinor: 3000, currency: "EUR", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, durationMinutes: 45 })).toBeNull();
    expect(resolveCoachingPrice([], target)).toBeNull();
  });

  it("never re-denominates an amount after the location currency changed", () => {
    expect(resolveCoachingPrice(prices, { ...target, locationCurrency: "EUR" })).toBeNull();
    // A stale override does not silently fall back to a (current) club default.
    const mixed = [price({ currency: "EUR", amountMinor: 2500 }), price({ coachUserId: coachB, amountMinor: 15000 })];
    expect(resolveCoachingPrice(mixed, { ...target, locationCurrency: "EUR", coachUserId: coachB })).toBeNull();
    expect(resolveCoachingPrice(mixed, { ...target, locationCurrency: "EUR", coachUserId: coachA })).toEqual({ amountMinor: 2500, currency: "EUR", source: "club" });
  });

  it("rejects ambiguous configuration instead of choosing arbitrarily", () => {
    expect(() => resolveCoachingPrice([price({}), price({ amountMinor: 1 })], target)).toThrow("Ambiguous");
  });
});
