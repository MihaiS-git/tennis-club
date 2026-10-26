import { describe, expect, it } from "vitest";
import {
  coachingFieldErrors, coachingPriceMutationSchema, coachingProgramMutationSchema, coachProfileMutationSchema,
  clubPriceSetMutationSchema, coachingParticipantCounts, formatParticipants, formatPlayers, parseTextList,
} from "@/lib/coaching/validation";

const fields = { name: "Private lesson", description: "", program_type: "private", durations: [60, 90],
  min_participants: 1, max_participants: 1, court_rental_included: true, is_active: true };

describe("coaching program validation", () => {
  it("accepts every program type and requires explicit participant limits only for active programs", () => {
    for (const program_type of ["private", "semi_private", "group", "junior"]) {
      for (const durations of [[60], [90], [120], [60, 90], [60, 120], [90, 120], [60, 90, 120]]) {
        expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, program_type, durations } }).success).toBe(true);
      }
    }
    for (const [min_participants, max_participants] of [[1, 100], [3, 6], [8, 8]])
      expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, min_participants, max_participants } }).success).toBe(true);
    // An inactive program keeps incomplete limits until an Admin completes them.
    expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, min_participants: null, max_participants: null, is_active: false } }).success).toBe(true);
  });

  it.each([undefined, "a1000000-0000-4000-8000-000000000001"])("restricts create/update durations (id=%s)", (id) => {
    for (const durations of [[60], [90], [120], [60, 90, 120]]) {
      expect(coachingProgramMutationSchema.safeParse({ id, fields: { ...fields, durations } }).success).toBe(true);
    }
    for (const minutes of [15, 30, 45, 75, 105, 150, 480]) {
      expect(coachingProgramMutationSchema.safeParse({ id, fields: { ...fields, durations: [60, minutes] } }).success).toBe(false);
    }
    expect(coachingProgramMutationSchema.safeParse({ id, fields: { ...fields, other_durations: "105" } }).success).toBe(false);
    expect(coachingProgramMutationSchema.safeParse({ id, fields, other_durations: "105" }).success).toBe(false);
  });

  it("rejects invalid durations, limits, types and unknown fields with field errors", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ durations: [] }, "durations"], [{ durations: [60, 60] }, "durations"], [{ durations: [62] }, "durations"],
      [{ durations: [10] }, "durations"], [{ min_participants: 4, max_participants: 2 }, "max_participants"],
      [{ min_participants: null }, "min_participants"], [{ max_participants: null }, "max_participants"],
      [{ min_participants: 0 }, "min_participants"], [{ max_participants: 101 }, "max_participants"],
      [{ program_type: "camp" }, "program_type"], [{ name: " " }, "name"],
    ];
    for (const [change, field] of cases) {
      const parsed = coachingProgramMutationSchema.safeParse({ fields: { ...fields, ...change } });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(Object.keys(coachingFieldErrors(parsed.error.issues))).toContain(field);
    }
    expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, price: 100 } }).success).toBe(false);
  });
});

describe("coach profile and price validation", () => {
  const coach = { display_name: "Ana", bio: "", qualifications: "", specialties: [], languages: ["English"],
    location_ids: [], program_ids: [], is_public: false };
  it("validates the explicit public profile fields only", () => {
    const user_id = "c1000000-0000-4000-8000-00000000000a";
    expect(coachProfileMutationSchema.safeParse({ user_id, create: true, fields: coach }).success).toBe(true);
    expect(coachProfileMutationSchema.safeParse({ user_id, create: true, fields: { ...coach, email: "a@example.test" } }).success).toBe(false);
    expect(coachProfileMutationSchema.safeParse({ user_id, create: true, fields: { ...coach, specialties: Array(13).fill("x") } }).success).toBe(false);
  });

  it("parses decimal amounts without floating point for a program, duration and supported currency", () => {
    const key = { program_id: "a1000000-0000-4000-8000-000000000001", duration_minutes: 60, participant_count: 1, currency: "RON" };
    expect(coachingPriceMutationSchema.parse({ ...key, amount: "120.5" }).amount).toBe(12050);
    for (const duration_minutes of [45, 150, 180]) {
      expect(coachingPriceMutationSchema.safeParse({ ...key, duration_minutes, amount: "100" }).success).toBe(false);
    }
    for (const participant_count of [0, 1.5, 101, undefined]) {
      expect(coachingPriceMutationSchema.safeParse({ ...key, participant_count, amount: "100" }).success).toBe(false);
    }
    expect(coachingPriceMutationSchema.safeParse({ ...key, amount: "0" }).success).toBe(false);
    expect(coachingPriceMutationSchema.safeParse({ ...key, amount: "1.234" }).success).toBe(false);
    expect(coachingPriceMutationSchema.safeParse({ ...key, amount: "10", currency: "XYZ" }).success).toBe(false);
    // Prices are club-wide and the input never names a location or a coach.
    expect(coachingPriceMutationSchema.safeParse({ ...key, amount: "10", location_id: "b1000000-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(coachingPriceMutationSchema.safeParse({ ...key, amount: "10", coach_user_id: null }).success).toBe(false);
  });

  it("formats lists and participant ranges", () => {
    expect(parseTextList(" Serve,  footwork , serve,, Junior development ")).toEqual(["Serve", "footwork", "Junior development"]);
    expect(formatParticipants(null, null)).toBeNull();
    expect(formatParticipants(1, 1)).toBe("1 player");
    expect(formatParticipants(2, 4)).toBe("2–4 players");
    expect(formatParticipants(null, 6)).toBe("Up to 6 players");
    expect(formatParticipants(3, null)).toBe("At least 3 players");
    expect(formatPlayers(1)).toBe("1 player");
    expect(formatPlayers(4)).toBe("4 players");
    expect(coachingParticipantCounts({ min: 2, max: 4 })).toEqual([2, 3, 4]);
    expect(coachingParticipantCounts(null)).toEqual([]);
  });
});

describe("club price set validation", () => {
  const rates = { program_id: "a1000000-0000-4000-8000-000000000001", currency: "RON", duration_minutes: 60,
    prices: [{ participant_count: 3, amount: "55.50" }], removed: [4] };

  it("accepts positive lesson prices/person in minor units by player count for one explicit duration", () => {
    expect(clubPriceSetMutationSchema.parse(rates)).toEqual({ ...rates, prices: [{ participant_count: 3, amount: 5550 }] });
    expect(clubPriceSetMutationSchema.safeParse({ ...rates, prices: [] }).success).toBe(true);
    expect(clubPriceSetMutationSchema.safeParse({ ...rates, duration_minutes: 90 }).success).toBe(true);
  });

  it("rejects missing, zero or malformed amounts, invalid counts, durations, currencies, conflicts and empty submissions", () => {
    const invalid = [
      { prices: [{ participant_count: 3, amount: "0" }] }, { prices: [{ participant_count: 3, amount: "-1" }] },
      { prices: [{ participant_count: 3, amount: "1.234" }] }, { prices: [{ participant_count: 3, amount: "" }] },
      { prices: [{ participant_count: 0, amount: "10" }] }, { prices: [{ participant_count: 2.5, amount: "10" }] },
      { prices: [{ participant_count: 101, amount: "10" }] }, { currency: "JPY" }, { currency: "ron" },
      { prices: [{ participant_count: 3, amount: "10" }, { participant_count: 3, amount: "12" }] },
      { removed: [3] }, { removed: [4, 4] }, { prices: [], removed: [] }, { duration_minutes: 45 }, { duration_minutes: undefined }, { duration_minutes: null },
      { prices: [{ participant_count: 3, amount: "10", duration_minutes: 60 }] }, { coach_user_id: null },
    ];
    for (const change of invalid) expect(clubPriceSetMutationSchema.safeParse({ ...rates, ...change }).success, JSON.stringify(change)).toBe(false);
    const result = clubPriceSetMutationSchema.safeParse({ ...rates, prices: [{ participant_count: 5, amount: "10" }, { participant_count: 6, amount: "0" }], removed: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(Object.keys(coachingFieldErrors(result.error.issues))).toEqual(["prices.1"]);
  });
});

describe("club prices saved with a program", () => {
  const semi = { ...fields, program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 4 };
  const group = { ...fields, program_type: "group", durations: [60, 90], min_participants: 4, max_participants: 8 };
  const errors = (input: unknown) => {
    const parsed = coachingProgramMutationSchema.safeParse(input);
    return parsed.success ? {} : coachingFieldErrors(parsed.error.issues);
  };

  it("accepts an independent price for each permitted count and selected duration", () => {
    const club_prices = [
      { currency: "RON", duration_minutes: 60, participant_count: 2, amount: "150" },
      { currency: "RON", duration_minutes: 60, participant_count: 3, amount: "210" },
      { currency: "RON", duration_minutes: 90, participant_count: 2, amount: "220" },
      { currency: "EUR", duration_minutes: 60, participant_count: 2, amount: "30" },
    ];
    const parsed = coachingProgramMutationSchema.parse({ fields: semi, club_prices });
    expect(parsed.club_prices?.map((price) => price.amount)).toEqual([15000, 21000, 22000, 3000]);
    // Group/Junior prices have the same meaning, tied to an explicit selected duration.
    const groupPrices = [{ currency: "RON", duration_minutes: 60, participant_count: 4, amount: "90" }, { currency: "RON", duration_minutes: 90, participant_count: 8, amount: "60" }];
    expect(coachingProgramMutationSchema.safeParse({ fields: group, club_prices: groupPrices }).success).toBe(true);
  });

  it("rejects prices outside the submitted range or durations, without a duration, and duplicates", () => {
    const at = (change: Record<string, unknown>) => [{ currency: "RON", duration_minutes: 60, participant_count: 2, amount: "150", ...change }];
    expect(errors({ fields: semi, club_prices: at({ participant_count: 5 }) })).toEqual({ "club_prices.0": "Use a player count from 2 to 4." });
    expect(errors({ fields: semi, club_prices: at({ participant_count: 1 }) })).toEqual({ "club_prices.0": "Use a player count from 2 to 4." });
    expect(errors({ fields: semi, club_prices: at({ duration_minutes: 120 }) })).toEqual({ "club_prices.0": "Select this duration before setting its price." });
    expect(Object.keys(errors({ fields: semi, club_prices: at({ duration_minutes: null }) }))).toEqual(["club_prices.0"]);
    expect(errors({ fields: { ...semi, min_participants: null, is_active: false }, club_prices: at({}) }))
      .toEqual({ "club_prices.0": "Set the minimum and maximum players before setting prices." });
    expect(errors({ fields: semi, club_prices: [...at({}), ...at({ amount: "160" })] })).toEqual({ "club_prices.1": "Enter each price once." });
    expect(errors({ fields: group, club_prices: at({ participant_count: 4 }) })).toEqual({});
    expect(Object.keys(errors({ fields: group, club_prices: at({ participant_count: 4, duration_minutes: null }) }))).toEqual(["club_prices.0"]);
    expect(Object.keys(errors({ fields: group, club_prices: at({ participant_count: 4, duration_minutes: 120 }) }))).toEqual(["club_prices.0"]);
    // Removing prices needs an existing program and never conflicts with a saved price.
    const removed_club_prices = [{ currency: "RON", duration_minutes: 60, participant_count: 2 }];
    expect(Object.keys(errors({ fields: semi, removed_club_prices }))).toEqual(["removed_club_prices.0"]);
    expect(Object.keys(errors({ id: "a1000000-0000-4000-8000-000000000001", fields: semi, club_prices: at({}), removed_club_prices }))).toEqual(["removed_club_prices.0"]);
    expect(coachingProgramMutationSchema.safeParse({ id: "a1000000-0000-4000-8000-000000000001", fields: semi, removed_club_prices }).success).toBe(true);
  });
});
