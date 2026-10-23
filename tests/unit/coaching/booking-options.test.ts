import { beforeEach, expect, it, vi } from "vitest";
import type { PublicCoaching } from "@/lib/coaching/public";

const { schedules, source } = vi.hoisted(() => ({ schedules: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: source }));
vi.mock("@/lib/db/repositories/coach-availability.repository", () => ({ listLocationCoachBookingAvailability: schedules }));
import { coachingBookingOptions } from "@/lib/coaching/booking-options";

const central = { id: "central", currency: "RON", timezone: "Europe/Bucharest" } as const;
const riverside = { ...central, id: "riverside" };
const now = new Date("2026-10-23T09:00:00Z"); // Friday, 12:00 local.
const price = { durationMinutes: 60, amountMinor: 20000, currency: "RON" } as const;
const program: PublicCoaching["programs"][number] = {
  id: "private", name: "Private", description: "", type: "private", durations: [60],
  minParticipants: null, maxParticipants: null, courtRentalIncluded: false, prices: [price],
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

it.each(["group", "junior"] as const)("excludes a coach offering only unsupported %s lessons", async type => {
  const facts = data();
  facts.programs[0].type = type;
  expect(await options(facts)).toEqual([]);
  expect(schedules).not.toHaveBeenCalled();
});

it("keeps a coach offering Private plus Group and leaves Group disabled", async () => {
  const facts = data();
  facts.programs.push({ ...program, id: "group", name: "Group", type: "group" });
  facts.coaches[0].programs = [...coach.programs, { id: "group", name: "Group" }];
  const result = await options(facts);
  expect(result).toHaveLength(1);
  expect(result[0].programs.find(item => item.id === "group")?.bookable).toBe(false);
});

it("excludes online lessons with no effective price or only another currency's price", async () => {
  const facts = data();
  facts.programs[0].prices = [];
  expect(await options(facts)).toEqual([]);
  facts.programs[0].prices = [{ ...price, currency: "EUR" }];
  expect(await options(facts)).toEqual([]);
});

it("requires a priced duration supported by the lesson grid", async () => {
  const facts = data();
  facts.programs[0].durations = [45];
  facts.programs[0].prices = [{ ...price, durationMinutes: 45 }];
  expect(await options(facts)).toEqual([]);
});

it("accepts the club default and prefers a coach override, including override-only prices", async () => {
  expect((await options())[0].programs[0].durations[0].price).toEqual({ amountMinor: price.amountMinor, currency: price.currency, source: "club" });
  const facts = data();
  facts.coaches[0].rates = [{ ...price, programId: program.id, programName: program.name, courtRentalIncluded: false, amountMinor: 25000 }];
  expect((await options(facts))[0].programs[0].durations[0].price).toMatchObject({ amountMinor: 25000, source: "coach" });
  facts.programs[0].prices = [];
  expect(await options(facts)).toHaveLength(1);
});

it("does not restore inactive/unassigned programs omitted by the public projection", async () => {
  const facts = data();
  facts.programs = [];
  expect(await options(facts)).toEqual([]);
  facts.programs = [program];
  facts.coaches[0].programs = [];
  expect(await options(facts)).toEqual([]);
});
