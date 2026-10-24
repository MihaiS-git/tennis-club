import { describe, expect, it } from "vitest";
import {
  coachingFieldErrors, coachingPriceMutationSchema, coachingProgramMutationSchema, coachProfileMutationSchema,
  formatParticipants, parseTextList, participantPriceMutationSchema,
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
    const key = { program_id: "a1000000-0000-4000-8000-000000000001", duration_minutes: 60, currency: "RON" };
    expect(coachingPriceMutationSchema.parse({ ...key, amount: "120.5" }).amount).toBe(12050);
    for (const duration_minutes of [45, 150, 180]) {
      expect(coachingPriceMutationSchema.safeParse({ ...key, duration_minutes, amount: "100" }).success).toBe(false);
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
  });
});

describe("Group and Junior rate validation", () => {
  const rates = { program_id: "a1000000-0000-4000-8000-000000000001", currency: "RON", prices: [{ participant_count: 3, amount: "55.50" }], removed: [4] };

  it("accepts positive rates in minor units by player count and explicit removals", () => {
    expect(participantPriceMutationSchema.parse(rates)).toEqual({ ...rates, prices: [{ participant_count: 3, amount: 5550 }] });
    expect(participantPriceMutationSchema.safeParse({ ...rates, prices: [] }).success).toBe(true);
  });

  it("rejects missing, zero or malformed amounts, invalid counts, currencies, conflicts and empty submissions", () => {
    const invalid = [
      { prices: [{ participant_count: 3, amount: "0" }] }, { prices: [{ participant_count: 3, amount: "-1" }] },
      { prices: [{ participant_count: 3, amount: "1.234" }] }, { prices: [{ participant_count: 3, amount: "" }] },
      { prices: [{ participant_count: 0, amount: "10" }] }, { prices: [{ participant_count: 2.5, amount: "10" }] },
      { prices: [{ participant_count: 101, amount: "10" }] }, { currency: "JPY" }, { currency: "ron" },
      { prices: [{ participant_count: 3, amount: "10" }, { participant_count: 3, amount: "12" }] },
      { removed: [3] }, { removed: [4, 4] }, { prices: [], removed: [] },
      { prices: [{ participant_count: 3, amount: "10", duration_minutes: 60 }] }, { coach_user_id: null },
    ];
    for (const change of invalid) expect(participantPriceMutationSchema.safeParse({ ...rates, ...change }).success, JSON.stringify(change)).toBe(false);
    const result = participantPriceMutationSchema.safeParse({ ...rates, prices: [{ participant_count: 5, amount: "10" }, { participant_count: 6, amount: "0" }], removed: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(Object.keys(coachingFieldErrors(result.error.issues))).toEqual(["prices.1"]);
  });

  it("does not accept per-duration club prices for Group and Junior programs", () => {
    const club_prices = [{ duration_minutes: 60, currency: "RON", amount: "100" }];
    for (const program_type of ["group", "junior"]) {
      expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, program_type, min_participants: 3, max_participants: 6 }, club_prices }).success).toBe(false);
    }
    expect(coachingProgramMutationSchema.safeParse({ fields, club_prices }).success).toBe(true);
  });
});
