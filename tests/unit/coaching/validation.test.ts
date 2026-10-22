import { describe, expect, it } from "vitest";
import {
  coachingFieldErrors, coachingPriceMutationSchema, coachingProgramMutationSchema, coachProfileMutationSchema,
  formatParticipants, parseTextList,
} from "@/lib/coaching/validation";

const fields = { name: "Private lesson", description: "", program_type: "private", durations: [60, 90],
  min_participants: null, max_participants: 1, court_rental_included: true, is_active: true };

describe("coaching program validation", () => {
  it("accepts configurable program types and optional participant limits", () => {
    for (const program_type of ["private", "semi_private", "group", "junior"]) {
      expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, program_type } }).success).toBe(true);
    }
    expect(coachingProgramMutationSchema.safeParse({ fields: { ...fields, max_participants: null } }).success).toBe(true);
  });

  it("rejects invalid durations, limits, types and unknown fields with field errors", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ durations: [] }, "durations"], [{ durations: [60, 60] }, "durations"], [{ durations: [62] }, "durations"],
      [{ durations: [10] }, "durations"], [{ min_participants: 4, max_participants: 2 }, "max_participants"],
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
