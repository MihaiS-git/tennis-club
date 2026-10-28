import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicCoaching } from "@/lib/coaching/public";

const { schedules, source } = vi.hoisted(() => ({ schedules: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: source }));
vi.mock("@/lib/db/repositories/coach-availability.repository", () => ({ listLocationCoachBookingAvailability: schedules }));
import { coachBookableLocations, coachingBookingOptions, coachingDurationPrice } from "@/lib/coaching/booking-options";

const central = { id: "central", currency: "RON", timezone: "Europe/Bucharest" } as const;
const riverside = { ...central, id: "riverside" };
const now = new Date("2026-10-23T09:00:00Z"); // Friday, 12:00 local.
const price = { durationMinutes: 60, participantCount: 1, amountMinor: 20000, currency: "RON" } as const;
const program: PublicCoaching["programs"][number] = {
  id: "private", name: "Private", description: "", type: "private", durations: [60],
  minParticipants: 1, maxParticipants: 1, courtRentalIncluded: false, prices: [price], fromPrices: [],
};
const coach: PublicCoaching["coaches"][number] = {
  id: "coach", displayName: "Coach", bio: "", qualifications: "", specialties: [], languages: [],
  locations: [{ id: central.id, name: "Central" }, { id: riverside.id, name: "Riverside" }], programs: [{ id: program.id, name: program.name }], rates: [],
};
const weekly = { coachUserId: coach.id, weekday: 0, startMinute: 480, endMinute: 1200, validFrom: "2026-01-01", validUntil: null };
const extra = { coachUserId: coach.id, exceptionDate: "2026-10-30", startMinute: 480, endMinute: 600 };
const data = (): PublicCoaching => ({ programs: [{ ...program }], coaches: [{ ...coach }] });
const options = (facts = data()) => coachingBookingOptions(facts, central, now);

beforeEach(() => {
  source.mockReset().mockResolvedValue({ manager: {} });
  schedules.mockReset().mockResolvedValue({ weekly: [weekly], extra: [] });
});

it("offers only Private and Semi-private programs for online booking", async () => {
  const types = ["private", "semi_private", "group", "junior"] as const;
  const programs = types.map((type) => ({ ...program, id: type, name: type, type, minParticipants: 1, maxParticipants: 6 }));
  const facts = { programs, coaches: [{ ...coach, programs: programs.map(({ id, name }) => ({ id, name })) }] };
  expect((await options(facts))[0].programs.map((item) => item.type)).toEqual(["private", "semi_private"]);
  // A coach assigned only Group/Junior programs offers nothing bookable online.
  const clubOnly = { programs, coaches: [{ ...coach, programs: programs.slice(2).map(({ id, name }) => ({ id, name })) }] };
  expect(await options(clubOnly)).toEqual([]);
});

it("uses working hours at the selected location for a coach assigned to two locations", async () => {
  schedules.mockImplementation(async (_manager, locationId) => ({ weekly: locationId === central.id ? [weekly] : [], extra: [] }));
  expect(await options()).toHaveLength(1);
  expect(await coachingBookingOptions(data(), riverside, now)).toEqual([]);
  expect(schedules).toHaveBeenLastCalledWith({}, riverside.id, [coach.id], "2026-10-23");
});

it("excludes assignment without working hours or extra availability", async () => {
  schedules.mockResolvedValue({ weekly: [], extra: [] });
  expect(await options()).toEqual([]);
});

it("includes future extra availability without weekly hours", async () => {
  schedules.mockResolvedValue({ weekly: [], extra: [extra] });
  expect(await options()).toHaveLength(1);
});

it("excludes only-expired weekly and extra availability", async () => {
  schedules.mockResolvedValue({ weekly: [{ ...weekly, validUntil: "2026-10-22" }], extra: [{ ...extra, exceptionDate: "2026-10-22" }] });
  expect(await options()).toEqual([]);
});

it("respects future weekly validity and requires the weekday to occur in the effective range", async () => {
  schedules.mockResolvedValue({ weekly: [{ ...weekly, validFrom: "2026-10-26", validUntil: "2026-10-26" }], extra: [] });
  expect(await options()).toHaveLength(1);
  schedules.mockResolvedValue({ weekly: [{ ...weekly, validFrom: "2026-10-27", validUntil: "2026-10-28" }], extra: [] });
  expect(await options()).toEqual([]);
});

it("uses local time and inclusive end dates for the last weekly occurrence", async () => {
  schedules.mockResolvedValue({ weekly: [{ ...weekly, weekday: 4, endMinute: 720, validUntil: "2026-10-23" }], extra: [] });
  expect(await options()).toEqual([]);
  schedules.mockResolvedValue({ weekly: [{ ...weekly, weekday: 4, endMinute: 750, validUntil: "2026-10-23" }], extra: [] });
  expect(await options()).toHaveLength(1);
  schedules.mockResolvedValue({ weekly: [{ ...weekly, weekday: 4, endMinute: 720 }], extra: [] });
  expect(await options()).toHaveLength(1); // Recurs next week.
});

it("ignores an ended extra interval today but accepts one that has not ended", async () => {
  schedules.mockResolvedValue({ weekly: [], extra: [{ ...extra, exceptionDate: "2026-10-23", endMinute: 720 }] });
  expect(await options()).toEqual([]);
  schedules.mockResolvedValue({ weekly: [], extra: [{ ...extra, exceptionDate: "2026-10-23", endMinute: 750 }] });
  expect(await options()).toHaveLength(1);
});

it("offers a Semi-private program with its configured participant range", async () => {
  const facts = data();
  facts.programs[0] = { ...facts.programs[0], type: "semi_private", minParticipants: 2, maxParticipants: 3, prices: [{ ...price, participantCount: 2 }] };
  expect(await options(facts)).toMatchObject([{ id: coach.id, programs: [{ id: "private", type: "semi_private", participants: { min: 2, max: 3 },
    durations: [{ durationMinutes: 60, prices: [{ participantCount: 2, price: { amountMinor: 40000, source: "club" } }, { participantCount: 3, price: null }] }] }] }]);
});

it.each([[null, 4], [2, null], [null, null], [5, 3], [0, 4], [1, 101]])(
  "never offers a program without valid explicit participant limits (min=%s, max=%s)", async (minParticipants, maxParticipants) => {
  const facts = data();
  facts.programs.push({ ...program, id: "semi", name: "Semi-private", type: "semi_private", minParticipants: 2, maxParticipants: 2,
    prices: [{ ...price, participantCount: 2 }] });
  facts.coaches[0].programs = [...coach.programs, { id: "semi", name: "Semi-private" }];
  facts.programs[0] = { ...facts.programs[0], minParticipants, maxParticipants };
  expect((await options(facts))[0].programs.map(item => [item.id, item.participants])).toEqual([["semi", { min: 2, max: 2 }]]);
  facts.programs.pop();
  expect(await options(facts)).toEqual([]);
});

it("excludes online lessons with no effective price or only another currency's price", async () => {
  const facts = data();
  facts.programs[0].prices = [];
  expect(await options(facts)).toEqual([]);
  facts.programs[0].prices = [{ ...price, currency: "EUR" }];
  expect(await options(facts)).toEqual([]);
  // A price for a count outside the range never makes the lesson bookable.
  facts.programs[0].prices = [{ ...price, participantCount: 2 }];
  expect(await options(facts)).toEqual([]);
});

it("resolves each permitted participant count's own configured price, without deriving missing counts", async () => {
  const facts = data();
  facts.programs[0] = { ...facts.programs[0], type: "semi_private", durations: [60, 90], minParticipants: 2, maxParticipants: 4,
    prices: [{ ...price, participantCount: 2, amountMinor: 15000 }, { ...price, participantCount: 3, amountMinor: 21000 },
      { ...price, durationMinutes: 90, participantCount: 2, amountMinor: 22000 }] };
  facts.coaches[0].rates = [{ ...price, participantCount: 3, amountMinor: 19000, programId: program.id, programName: program.name, courtRentalIncluded: false }];
  const [sixty, ninety] = (await options(facts))[0].programs[0].durations;
  // Each option is the lesson total: the count's own price/person times the count.
  expect(coachingDurationPrice(sixty, 2)).toEqual({ amountMinor: 30000, currency: "RON", source: "club" });
  expect(coachingDurationPrice(sixty, 3)).toEqual({ amountMinor: 57000, currency: "RON", source: "coach" });
  expect(coachingDurationPrice(sixty, 4)).toBeNull();
  expect(coachingDurationPrice(ninety, 2)).toEqual({ amountMinor: 44000, currency: "RON", source: "club" });
  expect(coachingDurationPrice(ninety, 3)).toBeNull();
  expect(coachingDurationPrice(ninety, 5)).toBeNull();
  expect(coachingDurationPrice(undefined, 2)).toBeNull();
});

it("requires a priced duration supported by the lesson grid", async () => {
  const facts = data();
  facts.programs[0].durations = [45];
  facts.programs[0].prices = [{ ...price, durationMinutes: 45 }];
  expect(await options(facts)).toEqual([]);
});

it("requires a club price in the location currency before offering coach overrides", async () => {
  expect(coachingDurationPrice((await options())[0].programs[0].durations[0], 1)).toEqual({ amountMinor: price.amountMinor, currency: price.currency, source: "club" });
  const facts = data();
  facts.coaches[0].rates = [{ ...price, programId: program.id, programName: program.name, courtRentalIncluded: false, amountMinor: 25000 }];
  expect(coachingDurationPrice((await options(facts))[0].programs[0].durations[0], 1)).toMatchObject({ amountMinor: 25000, source: "coach" });
  facts.programs[0].prices = [];
  expect(await options(facts)).toEqual([]);
  facts.programs[0].prices = [{ ...price, currency: "EUR" }];
  expect(await options(facts)).toEqual([]);
  // A partial club price grid is sufficient; an override can still price a different duration.
  facts.programs[0].durations = [60, 90];
  facts.programs[0].prices = [{ ...price, durationMinutes: 90 }];
  expect(await options(facts)).toHaveLength(1);
  expect(coachingDurationPrice((await options(facts))[0].programs[0].durations[0], 1)).toMatchObject({ amountMinor: 25000, source: "coach" });
});

it("omits an unpriced program even when the same coach offers another priced program", async () => {
  const facts = data();
  facts.programs.push({ ...program, id: "unpriced", prices: [] });
  facts.coaches[0].programs = [...coach.programs, { id: "unpriced", name: "Unpriced" }];
  facts.coaches[0].rates = [{ ...price, programId: "unpriced", programName: "Unpriced", courtRentalIncluded: false }];
  expect((await options(facts))[0].programs.map(item => item.id)).toEqual([program.id]);
});

it("does not restore inactive/unassigned programs omitted by the public projection", async () => {
  const facts = data();
  facts.programs = [];
  expect(await options(facts)).toEqual([]);
  facts.programs = [program];
  facts.coaches[0].programs = [];
  expect(await options(facts)).toEqual([]);
});

describe("coachBookableLocations", () => {
  const group: PublicCoaching["programs"][number] = { ...program, id: "group", name: "Group", type: "group", minParticipants: 3, maxParticipants: 6,
    prices: [{ ...price, participantCount: 3 }] };
  // Andrei: assigned to both, working only at Riverside. Maria: working at Central, Group only.
  const andrei = { ...coach, id: "andrei", displayName: "Andrei" };
  const maria = { ...coach, id: "maria", displayName: "Maria", locations: [{ id: central.id, name: "Central" }], programs: [{ id: group.id, name: group.name }] };
  const facts: PublicCoaching = { programs: [program, group], coaches: [andrei, maria] };
  const hours = (byLocation: Record<string, string[]>) => async (_manager: unknown, locationId: string, coachIds: string[]) => ({
    weekly: (byLocation[locationId] ?? []).filter(id => coachIds.includes(id)).map(coachUserId => ({ ...weekly, coachUserId })), extra: [] });

  it("returns only the assigned locations where the coach has working hours, in the given order", async () => {
    schedules.mockImplementation(hours({ [central.id]: ["maria"], [riverside.id]: ["andrei"] }));
    expect(await coachBookableLocations(facts, [central, riverside], "andrei", now)).toEqual([riverside]);
    expect(await coachBookableLocations(facts, [riverside, central], "ANDREI", now)).toEqual([riverside]);
    schedules.mockImplementation(hours({ [central.id]: ["andrei"], [riverside.id]: ["andrei"] }));
    expect(await coachBookableLocations(facts, [riverside, central], "andrei", now)).toEqual([riverside, central]);
  });

  it("returns nothing for a coach without online-bookable programs, working hours or a public profile", async () => {
    schedules.mockImplementation(hours({ [central.id]: ["maria"] }));
    expect(await coachBookableLocations(facts, [central, riverside], "maria", now)).toEqual([]);
    schedules.mockImplementation(hours({}));
    expect(await coachBookableLocations(facts, [central, riverside], "andrei", now)).toEqual([]);
    expect(await coachBookableLocations(facts, [central, riverside], "unknown", now)).toEqual([]);
  });

  it("ignores unassigned locations even with working hours there", async () => {
    schedules.mockImplementation(hours({ [riverside.id]: ["maria"] }));
    expect(await coachBookableLocations(facts, [central, riverside], "maria", now)).toEqual([]);
    expect(schedules).not.toHaveBeenCalledWith({}, riverside.id, expect.anything(), expect.anything());
  });
});
