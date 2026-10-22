import { describe, expect, it } from "vitest";
import { resolveCoachingPrice, type CoachingPriceRecord } from "@/lib/coaching/pricing";

const program = "a1000000-0000-4000-8000-000000000001";
const coachA = "c1000000-0000-4000-8000-00000000000a";
const coachB = "c1000000-0000-4000-8000-00000000000b";
const coachC = "c1000000-0000-4000-8000-00000000000c";

const price = (overrides: Partial<CoachingPriceRecord>): CoachingPriceRecord => ({
  programId: program, durationMinutes: 60, coachUserId: null, amountMinor: 12000, currency: "RON", ...overrides,
});
const prices = [
  price({}),
  price({ coachUserId: coachB, amountMinor: 15000 }),
  price({ coachUserId: coachC, amountMinor: 9000 }),
  price({ durationMinutes: 90, amountMinor: 17000 }),
  price({ amountMinor: 3000, currency: "EUR" }),
];
const target = { programId: program, durationMinutes: 60, currency: "RON" as const };

describe("resolveCoachingPrice", () => {
  it("uses the club default for the program, duration and currency when no override applies", () => {
    expect(resolveCoachingPrice(prices, target)).toEqual({ amountMinor: 12000, currency: "RON", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachA })).toEqual({ amountMinor: 12000, currency: "RON", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, currency: "EUR" })).toEqual({ amountMinor: 3000, currency: "EUR", source: "club" });
  });

  it("prefers the coach's own override whether higher or lower than the club default", () => {
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachB })).toEqual({ amountMinor: 15000, currency: "RON", source: "coach" });
    expect(resolveCoachingPrice(prices, { ...target, coachUserId: coachC.toUpperCase() })).toEqual({ amountMinor: 9000, currency: "RON", source: "coach" });
    // The override is per duration and currency; elsewhere the club default applies.
    expect(resolveCoachingPrice(prices, { ...target, durationMinutes: 90, coachUserId: coachB })).toEqual({ amountMinor: 17000, currency: "RON", source: "club" });
    expect(resolveCoachingPrice(prices, { ...target, currency: "EUR", coachUserId: coachB })).toEqual({ amountMinor: 3000, currency: "EUR", source: "club" });
  });

  it("returns no price instead of inventing or converting one", () => {
    expect(resolveCoachingPrice(prices, { ...target, durationMinutes: 45 })).toBeNull();
    expect(resolveCoachingPrice(prices, { ...target, currency: "USD", coachUserId: coachB })).toBeNull();
    expect(resolveCoachingPrice([], target)).toBeNull();
    // An override alone still prices that coach's lesson; other coaches stay unpriced.
    const overrideOnly = [price({ coachUserId: coachB, currency: "GBP", amountMinor: 5000 })];
    expect(resolveCoachingPrice(overrideOnly, { ...target, currency: "GBP", coachUserId: coachB })).toEqual({ amountMinor: 5000, currency: "GBP", source: "coach" });
    expect(resolveCoachingPrice(overrideOnly, { ...target, currency: "GBP", coachUserId: coachA })).toBeNull();
  });

  it("rejects ambiguous configuration instead of choosing arbitrarily", () => {
    expect(() => resolveCoachingPrice([price({}), price({ amountMinor: 1 })], target)).toThrow("Ambiguous");
  });
});
