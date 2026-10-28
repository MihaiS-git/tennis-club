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
    { program_id: ids.program, duration_minutes: 60, participant_count: 1, coach_user_id: null, amount_minor: 12000, currency: "RON" },
    { program_id: ids.program, duration_minutes: 60, participant_count: 1, coach_user_id: ids.bo, amount_minor: 15000, currency: "RON" },
    // No visible location charges in GBP, so it is never shown.
    { program_id: ids.program, duration_minutes: 60, participant_count: 1, coach_user_id: null, amount_minor: 9000, currency: "GBP" },
    // Outside the current 1-player range: never applicable, even if lower.
    { program_id: ids.program, duration_minutes: 60, participant_count: 2, coach_user_id: null, amount_minor: 100, currency: "RON" },
    // Group club lesson prices/person for 90 minutes; a Group coach override is never applicable.
    { program_id: ids.group, duration_minutes: 90, participant_count: 3, coach_user_id: null, amount_minor: 8000, currency: "RON" },
    { program_id: ids.group, duration_minutes: 90, participant_count: 3, coach_user_id: ids.bo, amount_minor: 6500, currency: "RON" },
    { program_id: ids.group, duration_minutes: 90, participant_count: 5, coach_user_id: null, amount_minor: 6000, currency: "RON" },
    { program_id: ids.group, duration_minutes: 90, participant_count: 4, coach_user_id: null, amount_minor: 1800, currency: "EUR" },
    // Outside the current 3–6 range, and a duration the program does not offer: not current prices.
    { program_id: ids.group, duration_minutes: 90, participant_count: 8, coach_user_id: null, amount_minor: 4000, currency: "RON" },
    { program_id: ids.group, duration_minutes: 60, participant_count: 3, coach_user_id: null, amount_minor: 3000, currency: "RON" },
    // No visible location charges in GBP.
    { program_id: ids.group, duration_minutes: 90, participant_count: 3, coach_user_id: null, amount_minor: 7000, currency: "GBP" },
  ],
};
const visible = [{ id: ids.east, name: "East", currency: "RON" as const }, { id: ids.west, name: "West", currency: "EUR" as const }];

describe("projectPublicCoaching", () => {
  const result = projectPublicCoaching(facts, visible);

  it("shows club-wide prices only in the currencies of visible locations", () => {
    expect(result.programs[0].prices).toEqual([{ durationMinutes: 60, participantCount: 1, amountMinor: 12000, currency: "RON" }]);
  });

  it("publishes Group/Junior club lesson prices/person by duration and player count, inside the current configuration only", () => {
    // Missing counts (4 and 6 in RON) are not filled in; EUR is kept separate from RON; the coach override is ignored.
    expect(result.programs[1].prices).toEqual([
      { durationMinutes: 90, participantCount: 4, amountMinor: 1800, currency: "EUR" },
      { durationMinutes: 90, participantCount: 3, amountMinor: 8000, currency: "RON" },
      { durationMinutes: 90, participantCount: 5, amountMinor: 6000, currency: "RON" },
    ]);
  });

  it("omits a program when it has no valid player range", () => {
    const incomplete = projectPublicCoaching({ ...facts, programs: facts.programs.map((program) =>
      program.id === ids.group ? { ...program, max_participants: null } : program) }, visible);
    expect(incomplete.programs.map(program => program.id)).toEqual([ids.program]);
  });

  it("lists coach locations, programs and only their individual rates", () => {
    const [ana, bo] = result.coaches;
    expect(ana.locations).toEqual([{ id: ids.east, name: "East" }]);
    expect(ana.rates).toEqual([]);
    expect(bo.programs.map((program) => program.name)).toEqual(["Group", "Private"]);
    expect(bo.rates).toEqual([{ programId: ids.program, programName: "Private", courtRentalIncluded: true,
      durationMinutes: 60, participantCount: 1, amountMinor: 15000, currency: "RON" }]);
  });

  it("exposes no account or contact fields", () => {
    expect(JSON.stringify(result)).not.toMatch(/email|phone|status|is_public/);
  });

  it("renders nothing invented when nothing is configured", () => {
    expect(projectPublicCoaching({ programs: [], coaches: [], prices: [] }, visible)).toEqual({ programs: [], coaches: [] });
  });
});

describe("club-price publication prerequisite", () => {
  const types = ["private", "semi_private", "group", "junior"] as const;
  const program = (program_type: typeof types[number]) => ({ ...facts.programs[0], program_type,
    durations: [60, 90], min_participants: 2, max_participants: 4 });
  const price = { ...facts.prices[0], participant_count: 2 };
  const project = (program_type: typeof types[number], prices: PublicCoachingFacts["prices"]) =>
    ({ ...facts, programs: [program(program_type)], prices });

  it.each(types)("hides %s programs without club prices, even with coach-only overrides", (type) => {
    for (const prices of [[], [{ ...price, coach_user_id: ids.bo }]]) {
      const input = project(type, prices);
      const result = projectPublicCoaching(input, visible);
      expect(result.programs).toEqual([]);
      expect(result.coaches.every(coach => coach.programs.length === 0 && coach.rates.length === 0)).toBe(true);
      const profile = projectPublicCoachProfile(input, visible, ids.bo);
      expect(profile?.programs).toEqual([]);
      expect(profile?.lessons).toEqual([]);
      // Public projection does not remove configuration or assignments from Admin facts.
      expect(input.programs).toHaveLength(1);
      expect(input.coaches[1].program_ids).toContain(ids.program);
    }
  });

  it.each(types)("publishes a partially priced %s program with just one applicable club price", (type) => {
    const result = projectPublicCoaching(project(type, [price]), visible);
    expect(result.programs).toMatchObject([{ id: ids.program, durations: [60, 90], minParticipants: 2, maxParticipants: 4,
      prices: [{ durationMinutes: 60, participantCount: 2, currency: "RON", amountMinor: price.amount_minor }] }]);
    expect(result.coaches[1].programs).toEqual([{ id: ids.program, name: "Private" }]);
  });

  it.each([
    { duration_minutes: 120 }, // Canonical, but not offered by this program.
    { duration_minutes: 45 },
    { participant_count: 1 },
    { participant_count: 5 },
    { currency: "GBP" }, // No public location charges GBP.
    { currency: "invalid" },
  ])("does not publish on an inapplicable club price (%j) or a valid coach override", (change) => {
    const input = project("semi_private", [{ ...price, ...change }, { ...price, coach_user_id: ids.bo }]);
    expect(projectPublicCoaching(input, visible).programs).toEqual([]);
  });

  it("requires a club price in the currencies of the requested public locations", () => {
    const input = project("semi_private", [price, { ...price, currency: "EUR", coach_user_id: ids.bo }]);
    expect(projectPublicCoaching(input, [visible[0]]).programs).toHaveLength(1);
    expect(projectPublicCoaching(input, [visible[1]]).programs).toEqual([]);
    input.prices.push({ ...price, currency: "EUR", amount_minor: 3500 });
    expect(projectPublicCoaching(input, [visible[1]]).programs[0].prices)
      .toEqual([{ durationMinutes: 60, participantCount: 2, currency: "EUR", amountMinor: 3500 }]);
    expect(projectPublicCoaching(input, []).programs).toEqual([]);
  });
});

describe("public From prices", () => {
  const semi = { id: "a1000000-0000-4000-8000-000000000003", name: "Semi-private", description: "", program_type: "semi_private",
    min_participants: 2, max_participants: 4, court_rental_included: true, durations: [60, 90] };
  const lesson = (duration_minutes: number, participant_count: number, amount_minor: number, coach_user_id: string | null = null, currency = "RON") =>
    ({ program_id: semi.id, duration_minutes, participant_count, coach_user_id, amount_minor, currency });
  const coach = (user_id: string, location_ids: string[]) => ({ user_id, display_name: user_id, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids, program_ids: [semi.id] });
  const from = (prices: PublicCoachingFacts["prices"], coaches = [coach(ids.ana, [ids.east])]) =>
    projectPublicCoaching({ programs: [semi], coaches, prices }, visible).programs[0]?.fromPrices ?? [];

  it("advertises the lowest configured lesson price of any count and duration, never a derived one", () => {
    // 2 players RON 150, 3 players RON 210, 4 players unconfigured; 90 minutes RON 220 for 2 players.
    expect(from([lesson(60, 2, 15000), lesson(60, 3, 21000), lesson(90, 2, 22000)])).toEqual([{ currency: "RON", amountMinor: 15000 }]);
    // The lowest price may be for a larger group or a longer lesson; nothing is divided per player.
    expect(from([lesson(60, 2, 15000), lesson(90, 4, 14000)])).toEqual([{ currency: "RON", amountMinor: 14000 }]);
    expect(from([])).toEqual([]);
  });

  it("uses each eligible coach's effective price: a lower override lowers it, a higher one does not hide the club price", () => {
    const coaches = [coach(ids.ana, [ids.east]), coach(ids.bo, [ids.east])];
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 13000, ids.bo)], coaches)).toEqual([{ currency: "RON", amountMinor: 13000 }]);
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 18000, ids.bo)], coaches)).toEqual([{ currency: "RON", amountMinor: 15000 }]);
    // Every eligible coach charges the override: the club default is not offered.
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 18000, ids.ana), lesson(60, 2, 17000, ids.bo)], coaches)).toEqual([{ currency: "RON", amountMinor: 17000 }]);
    // Overrides cannot publish a program, but can price another combination once a club price exists.
    expect(from([lesson(60, 3, 16000, ids.bo)], coaches)).toEqual([]);
    expect(from([lesson(90, 2, 18000), lesson(60, 3, 16000, ids.bo)], coaches)).toEqual([{ currency: "RON", amountMinor: 16000 }]);
  });

  it("ignores overrides of coaches who are not assigned or do not teach in that currency, and out-of-range or obsolete prices", () => {
    const hidden = { ...coach(ids.bo, [ids.east]), program_ids: [] };
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 9000, ids.bo)], [coach(ids.ana, [ids.east]), hidden])).toEqual([{ currency: "RON", amountMinor: 15000 }]);
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 9000, ids.bo)], [coach(ids.ana, [ids.east]), coach(ids.bo, [ids.west])]))
      .toEqual([{ currency: "RON", amountMinor: 15000 }]);
    expect(from([lesson(60, 2, 15000), lesson(60, 5, 100), lesson(60, 1, 100), lesson(120, 2, 100)])).toEqual([{ currency: "RON", amountMinor: 15000 }]);
  });

  it("keeps currencies separate and shows only those of visible locations", () => {
    const coaches = [coach(ids.ana, [ids.east, ids.west])];
    expect(from([lesson(60, 2, 15000), lesson(60, 3, 3500, null, "EUR"), lesson(60, 2, 900, null, "GBP")], coaches))
      .toEqual([{ currency: "EUR", amountMinor: 3500 }, { currency: "RON", amountMinor: 15000 }]);
  });

  it("advertises club prices in a currency no eligible coach teaches in", () => {
    expect(from([lesson(60, 2, 15000), lesson(60, 2, 9000, ids.ana)], [])).toEqual([{ currency: "RON", amountMinor: 15000 }]);
  });

  it("advertises the lowest configured Group/Junior club lesson price/person in range, ignoring coach overrides", () => {
    const result = projectPublicCoaching(facts, visible).programs[1];
    // RON 80 (3 players) and RON 60 (5 players); RON 40 for 8 players and the 60-minute price are not current; Bo's RON 65 override is ignored.
    expect(result.fromPrices).toEqual([{ currency: "EUR", amountMinor: 1800 }, { currency: "RON", amountMinor: 6000 }]);
    const group = { ...facts.programs[1], min_participants: 4, max_participants: 8, durations: [60, 90] };
    const prices = [[60, 4, 9000], [90, 6, 7000], [90, 8, 6500]].map(([duration_minutes, participant_count, amount_minor]) =>
      ({ program_id: ids.group, duration_minutes, participant_count, coach_user_id: null, amount_minor, currency: "RON" }));
    expect(projectPublicCoaching({ ...facts, programs: [group], prices }, visible).programs[0].fromPrices)
      .toEqual([{ currency: "RON", amountMinor: 6500 }]);
  });
});

describe("projectPublicCoachProfile", () => {
  it("prices every lesson with the coach override, else the club default, else no price", () => {
    const bo = projectPublicCoachProfile(facts, visible, ids.bo.toUpperCase());
    expect(bo?.programs.map((program) => [program.name, program.durations, program.courtRentalIncluded])).toEqual([["Group", [90], false], ["Private", [60], true]]);
    expect(bo?.locations).toEqual([{ id: ids.east, name: "East" }, { id: ids.west, name: "West" }]);
    // Group lessons have no coach lesson prices: Bo's obsolete Group override is not listed.
    expect(bo?.lessons.map((lesson) => [lesson.currency, lesson.programName, lesson.durationMinutes, lesson.participantCount, lesson.price])).toEqual([
      // West charges in EUR; the RON club default is never converted.
      ["EUR", "Private", 60, 1, null],
      ["RON", "Private", 60, 1, { amountMinor: 15000, currency: "RON", source: "coach" }],
    ]);
    const ana = projectPublicCoachProfile(facts, visible, ids.ana);
    expect(ana?.lessons).toEqual([{ programId: ids.program, programName: "Private", currency: "RON",
      durationMinutes: 60, participantCount: 1, price: { amountMinor: 12000, currency: "RON", source: "club" } }]);
  });

  it("prices each currency of the coach's locations independently", () => {
    const euro = projectPublicCoachProfile({ ...facts, prices: [...facts.prices,
      { program_id: ids.program, duration_minutes: 60, participant_count: 1, coach_user_id: ids.bo, amount_minor: 3500, currency: "EUR" }] }, visible, ids.bo);
    expect(euro?.lessons.find((lesson) => lesson.currency === "EUR" && lesson.programId === ids.program)?.price)
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
