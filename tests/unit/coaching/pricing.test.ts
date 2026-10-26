import { describe, expect, it } from "vitest";
import { coachingLessonAmount, lowestPricesByCurrency, resolveCoachingPrice, type CoachingPriceRecord } from "@/lib/coaching/pricing";

const program = "a1000000-0000-4000-8000-000000000001";
const coachA = "c1000000-0000-4000-8000-00000000000a";
const coachB = "c1000000-0000-4000-8000-00000000000b";
const coachC = "c1000000-0000-4000-8000-00000000000c";

const price = (overrides: Partial<CoachingPriceRecord>): CoachingPriceRecord => ({
  programId: program, durationMinutes: 60, participantCount: 1, coachUserId: null, amountMinor: 12000, currency: "RON", ...overrides,
});
const prices = [
  price({}),
  price({ coachUserId: coachB, amountMinor: 15000 }),
  price({ coachUserId: coachC, amountMinor: 9000 }),
  price({ durationMinutes: 90, amountMinor: 17000 }),
  price({ amountMinor: 3000, currency: "EUR" }),
];
const target = { programId: program, durationMinutes: 60, participantCount: 1, currency: "RON" as const };

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

  it("resolves each participant count independently, never deriving one count's price from another", () => {
    // Semi-private, 60 min: 2 players RON 150, 3 players RON 210, 4 players unconfigured.
    const tiers = [
      price({ participantCount: 2, amountMinor: 15000 }),
      price({ participantCount: 3, amountMinor: 21000 }),
      price({ participantCount: 3, coachUserId: coachB, amountMinor: 19000 }),
    ];
    const at = (participantCount: number, coachUserId?: string) => resolveCoachingPrice(tiers, { ...target, participantCount, coachUserId });
    expect(at(2)).toEqual({ amountMinor: 15000, currency: "RON", source: "club" });
    expect(at(3)).toEqual({ amountMinor: 21000, currency: "RON", source: "club" });
    expect(at(4)).toBeNull();
    expect(at(1)).toBeNull();
    // A coach override is per count: coach B's 3-player price leaves the 2-player club price.
    expect(at(3, coachB)).toEqual({ amountMinor: 19000, currency: "RON", source: "coach" });
    expect(at(2, coachB)).toEqual({ amountMinor: 15000, currency: "RON", source: "club" });
    expect(at(4, coachB)).toBeNull();
  });

  it("rejects ambiguous configuration instead of choosing arbitrarily", () => {
    expect(() => resolveCoachingPrice([price({}), price({ amountMinor: 1 })], target)).toThrow("Ambiguous");
  });
});

describe("lesson price/person", () => {
  // The example configuration: every duration × participant count is entered independently.
  const configured = [
    price({ durationMinutes: 60, participantCount: 1, amountMinor: 9000 }), price({ durationMinutes: 60, participantCount: 2, amountMinor: 8000 }),
    price({ durationMinutes: 90, participantCount: 1, amountMinor: 13000 }), price({ durationMinutes: 90, participantCount: 2, amountMinor: 11000 }),
    price({ durationMinutes: 120, participantCount: 1, amountMinor: 17000 }), price({ durationMinutes: 120, participantCount: 2, amountMinor: 15000 }),
  ];
  const total = (durationMinutes: number, participantCount: number) => {
    const resolved = resolveCoachingPrice(configured, { ...target, durationMinutes, participantCount });
    return resolved && coachingLessonAmount(resolved.amountMinor, participantCount);
  };

  it("charges the exact configured price/person times the participant count, never scaled by duration", () => {
    expect(total(60, 1)).toBe(9000);
    expect(total(60, 2)).toBe(16000);
    expect(total(90, 1)).toBe(13000);
    expect(total(90, 2)).toBe(22000);
    expect(total(120, 1)).toBe(17000);
    expect(total(120, 2)).toBe(30000);
  });

  it("leaves a missing duration or count unavailable instead of extrapolating from another price", () => {
    const sixtyOnly = configured.filter((item) => item.durationMinutes === 60 && item.participantCount === 1);
    expect(resolveCoachingPrice(sixtyOnly, { ...target, durationMinutes: 90 })).toBeNull();
    expect(resolveCoachingPrice(sixtyOnly, { ...target, participantCount: 2 })).toBeNull();
    expect(resolveCoachingPrice(configured, { ...target, participantCount: 3 })).toBeNull();
  });

  it("changing one configured price leaves every other price unchanged", () => {
    const edited = configured.map((item) => item.durationMinutes === 90 && item.participantCount === 2 ? { ...item, amountMinor: 12500 } : item);
    for (const [duration, count] of [[60, 1], [60, 2], [90, 1], [120, 1], [120, 2]]) {
      expect(resolveCoachingPrice(edited, { ...target, durationMinutes: duration, participantCount: count }))
        .toEqual(resolveCoachingPrice(configured, { ...target, durationMinutes: duration, participantCount: count }));
    }
    expect(resolveCoachingPrice(edited, { ...target, durationMinutes: 90, participantCount: 2 })?.amountMinor).toBe(12500);
  });

  it("has no pricing unit setting on any program type", async () => {
    const { coachingProgramFieldsSchema, coachingProgramTypes } = await import("@/lib/coaching/validation");
    for (const program_type of coachingProgramTypes) {
      const fields = { name: "Program", description: "", program_type, durations: [60], min_participants: 1, max_participants: 2,
        court_rental_included: true, is_active: true };
      expect(coachingProgramFieldsSchema.safeParse(fields).success).toBe(true);
      expect(coachingProgramFieldsSchema.safeParse({ ...fields, pricing_unit: "person-hour" }).success).toBe(false);
    }
  });
});

it("finds the lowest price within each currency, preserves currency order and handles no prices", () => {
  expect(lowestPricesByCurrency([])).toEqual([]);
  expect(lowestPricesByCurrency([
    { currency: "RON", amountMinor: 15000 }, { currency: "EUR", amountMinor: 3000 },
    { currency: "RON", amountMinor: 9000 }, { currency: "EUR", amountMinor: 4000 },
  ])).toEqual([{ currency: "EUR", amountMinor: 3000 }, { currency: "RON", amountMinor: 9000 }]);
});
