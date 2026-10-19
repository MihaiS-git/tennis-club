import { describe, expect, it } from "vitest";
import { projectPublicCoaching, projectPublicCoachProfile } from "@/lib/coaching/public";
import type { PublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";

const ids = {
  program: "a1000000-0000-4000-8000-000000000001", group: "a1000000-0000-4000-8000-000000000002",
  east: "b1000000-0000-4000-8000-000000000001", west: "b1000000-0000-4000-8000-000000000002", hidden: "b1000000-0000-4000-8000-000000000003",
  ana: "c1000000-0000-4000-8000-00000000000a", bo: "c1000000-0000-4000-8000-00000000000b",
};
const facts: PublicCoachingFacts = {
  programs: [
    { id: ids.program, name: "Private", description: "One to one.", program_type: "private", min_participants: 1, max_participants: 1,
      court_rental_included: true, durations: [60] },
    { id: ids.group, name: "Group", description: "", program_type: "group", min_participants: 3, max_participants: 6,
      court_rental_included: false, durations: [90] },
  ],
  coaches: [
    { user_id: ids.ana, display_name: "Ana", bio: "", qualifications: "", specialties: [], languages: [],
      location_ids: [ids.east, ids.hidden], program_ids: [ids.program] },
    { user_id: ids.bo, display_name: "Bo", bio: "", qualifications: "", specialties: [], languages: [],
      location_ids: [ids.east, ids.west], program_ids: [ids.program, ids.group] },
  ],
  prices: [
    { program_id: ids.program, duration_minutes: 60, location_id: ids.east, coach_user_id: null, amount_minor: 12000, currency: "RON" },
    { program_id: ids.program, duration_minutes: 60, location_id: ids.east, coach_user_id: ids.bo, amount_minor: 15000, currency: "RON" },
    { program_id: ids.program, duration_minutes: 60, location_id: ids.west, coach_user_id: null, amount_minor: 4000, currency: "RON" },
    { program_id: ids.program, duration_minutes: 60, location_id: ids.hidden, coach_user_id: null, amount_minor: 9000, currency: "RON" },
  ],
};
const visible = [{ id: ids.east, name: "East", currency: "RON" as const }, { id: ids.west, name: "West", currency: "EUR" as const }];

describe("projectPublicCoaching", () => {
  const result = projectPublicCoaching(facts, visible);

  it("shows club prices only at visible locations in their current currency", () => {
    expect(result.programs[0].prices).toEqual([{ locationId: ids.east, locationName: "East", durationMinutes: 60, amountMinor: 12000, currency: "RON" }]);
    expect(result.programs[1].prices).toEqual([]);
  });

  it("lists coach locations, programs and only their individual rates", () => {
    const [ana, bo] = result.coaches;
    expect(ana.locations).toEqual([{ id: ids.east, name: "East" }]);
    expect(ana.rates).toEqual([]);
    expect(bo.programs.map((program) => program.name)).toEqual(["Group", "Private"]);
    expect(bo.rates).toEqual([{ programId: ids.program, programName: "Private", courtRentalIncluded: true, locationId: ids.east,
      locationName: "East", durationMinutes: 60, amountMinor: 15000, currency: "RON" }]);
  });

  it("exposes no account or contact fields", () => {
    expect(JSON.stringify(result)).not.toMatch(/email|phone|status|is_public/);
  });

  it("renders nothing invented when nothing is configured", () => {
    expect(projectPublicCoaching({ programs: [], coaches: [], prices: [] }, visible)).toEqual({ programs: [], coaches: [] });
  });
});

describe("projectPublicCoachProfile", () => {
  it("prices every lesson with the coach override, else the club default, else no price", () => {
    const bo = projectPublicCoachProfile(facts, visible, ids.bo.toUpperCase());
    expect(bo?.programs.map((program) => [program.name, program.durations, program.courtRentalIncluded])).toEqual([["Group", [90], false], ["Private", [60], true]]);
    expect(bo?.locations).toEqual([{ id: ids.east, name: "East" }, { id: ids.west, name: "West" }]);
    expect(bo?.lessons.map((lesson) => [lesson.locationName, lesson.programName, lesson.durationMinutes, lesson.price])).toEqual([
      ["East", "Group", 90, null],
      ["East", "Private", 60, { amountMinor: 15000, currency: "RON", source: "coach" }],
      // West now prices in EUR, so the RON club default is not re-denominated.
      ["West", "Group", 90, null],
      ["West", "Private", 60, null],
    ]);
    const ana = projectPublicCoachProfile(facts, visible, ids.ana);
    expect(ana?.lessons).toEqual([{ locationId: ids.east, locationName: "East", programId: ids.program, programName: "Private",
      durationMinutes: 60, price: { amountMinor: 12000, currency: "RON", source: "club" } }]);
  });

  it("uses the configured location currency", () => {
    const euro = projectPublicCoachProfile({ ...facts, prices: [...facts.prices,
      { program_id: ids.program, duration_minutes: 60, location_id: ids.west, coach_user_id: ids.bo, amount_minor: 3500, currency: "EUR" }] }, visible, ids.bo);
    expect(euro?.lessons.find((lesson) => lesson.locationId === ids.west && lesson.programId === ids.program)?.price)
      .toEqual({ amountMinor: 3500, currency: "EUR", source: "coach" });
  });

  it("returns null for coaches outside the public projection", () => {
    expect(projectPublicCoachProfile(facts, visible, "c1000000-0000-4000-8000-00000000000f")).toBeNull();
  });

  it("exposes only public profile fields", () => {
    const profile = projectPublicCoachProfile(facts, visible, ids.ana)!;
    expect(Object.keys(profile).sort()).toEqual(["bio", "displayName", "id", "languages", "lessons", "locations", "programs", "qualifications", "specialties"]);
    expect(JSON.stringify(profile)).not.toMatch(/email|phone|status|is_public|avatar/);
  });
});
