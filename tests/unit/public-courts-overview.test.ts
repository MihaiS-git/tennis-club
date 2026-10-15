import { beforeEach, expect, it, vi } from "vitest";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import type { PricingRule } from "@/lib/pricing/validation";
import type { PublicLocation } from "@/lib/courts/public";

const reads = vi.hoisted(() => ({ locations: vi.fn(), hours: vi.fn(), coverage: vi.fn(), pricing: vi.fn(), occupancy: vi.fn() }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: reads.locations }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listPublicDayOpeningHours: reads.hours, listPublicDayCoverage: reads.coverage }));
vi.mock("@/lib/db/repositories/pricing.repository", () => ({ listPublicDayPricing: reads.pricing }));
vi.mock("@/lib/db/repositories/reservations.repository", () => ({ listPublicDayOccupancy: reads.occupancy }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { getPublicCourtDay, listPublicLocationsToday } from "@/lib/courts/public-calendar";

const id = "11111111-1111-4111-8111-111111111111";
const courtId = "22222222-2222-4222-8222-222222222222";
const stamp = "2026-10-01T00:00:00Z";
const location: PublicLocation = { id, name: "Club", slug: "club", address_line1: null, address_line2: null,
  city: null, postal_code: null, country_code: null, timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: false, todayOpeningHours: [],
  courts: [{ id: courtId, name: "Court", slug: "court", surface: "clay", environment: "outdoor", has_lighting: true }] };
const hours = (start: number, end: number): OpeningInterval => ({ id: crypto.randomUUID(), location_id: id,
  weekday: 3, opens_at_minute: start, closes_at_minute: end, created_at: stamp, updated_at: stamp });
const price = (start: number, end: number, amount: number, change: Partial<PricingRule> = {}): PricingRule => ({
  id: crypto.randomUUID(), rule_set_id: crypto.randomUUID(), location_id: id, court_id: courtId, court_state: "outdoor", weekday: 3,
  starts_at_minute: start, ends_at_minute: end, price_per_hour_minor: amount, starts_on: null, ends_on: null,
  created_at: stamp, updated_at: stamp, ...change });
const now = new Date("2026-10-15T09:15:00Z"); // Thursday, 12:15 in Bucharest.

beforeEach(() => {
  vi.resetAllMocks();
  reads.locations.mockResolvedValue([location]); reads.hours.mockResolvedValue([hours(480, 600), hours(660, 780)]);
  reads.coverage.mockResolvedValue([]); reads.pricing.mockResolvedValue([price(480, 780, 5000)]); reads.occupancy.mockResolvedValue([]);
});

it("preserves discovered location/court order and attributes, using each location's local date and weekday", async () => {
  const west = { ...location, id: "33333333-3333-4333-8333-333333333333", timezone: "America/Los_Angeles", currency: "USD" as const };
  reads.locations.mockResolvedValue([west, location]);
  reads.hours.mockResolvedValue([]);
  const result = await listPublicLocationsToday(new Date("2026-10-14T22:30:00Z"));
  expect(result.map(({ openingHours, startingRateMinor, ...rest }) => {
    expect(openingHours).toEqual([]); expect(startingRateMinor).toBeNull(); return rest;
  })).toEqual([west, location]);
  expect(reads.hours).toHaveBeenCalledWith(expect.anything(), west.id, 2, "2026-10-14");
  expect(reads.hours).toHaveBeenCalledWith(expect.anything(), location.id, 3, "2026-10-15");
  expect(reads.pricing).toHaveBeenCalledWith(expect.anything(), location.id, [courtId], 3, "2026-10-15");
  expect(reads.coverage).toHaveBeenCalledWith(expect.anything(), west.id, [courtId], "2026-10-14");
  expect(reads.occupancy).not.toHaveBeenCalled();
});

it("sorts daily intervals and excludes closed gaps, outside-hours, wrong-day and out-of-date prices", async () => {
  reads.hours.mockResolvedValue([hours(660, 780), hours(480, 600)]);
  reads.pricing.mockResolvedValue([price(0, 480, 1), price(480, 600, 5000), price(600, 660, 2), price(660, 780, 6500),
    price(780, 1440, 3), price(480, 780, 4, { weekday: 2 }),
    price(480, 780, 5, { ends_on: "2026-10-14" }), price(480, 780, 6, { starts_on: "2026-10-16" })]);
  expect(await listPublicLocationsToday(now)).toEqual([{ ...location,
    openingHours: [{ opens_at_minute: 480, closes_at_minute: 600 }, { opens_at_minute: 660, closes_at_minute: 780 }], startingRateMinor: 5000 }]);
});

it.each([
  ["outdoor", false, 5000], ["outdoor", true, 7000], ["indoor", false, 9000],
] as const)("resolves %s courts with coverage=%s", async (environment, covered, expected) => {
  reads.locations.mockResolvedValue([{ ...location, courts: [{ ...location.courts[0], environment }] }]);
  reads.coverage.mockResolvedValue(covered ? [{ id: crypto.randomUUID(), court_id: courtId,
    starts_on: "2026-10-15", ends_on: "2026-10-15", created_at: stamp, updated_at: stamp }] : []);
  reads.pricing.mockResolvedValue([price(480, 780, 5000), price(480, 780, 7000, { court_state: "covered" }),
    price(480, 780, 9000, { court_state: "indoor" })]);
  expect((await listPublicLocationsToday(now))[0].startingRateMinor).toBe(expected);
});

it.each(["closed", "unpriced", "wrong state"])("returns a null rate for %s today", async (kind) => {
  if (kind === "closed") reads.hours.mockResolvedValue([]);
  if (kind === "unpriced") reads.pricing.mockResolvedValue([]);
  if (kind === "wrong state") reads.pricing.mockResolvedValue([price(480, 780, 100, { court_state: "covered" })]);
  expect((await listPublicLocationsToday(now))[0].startingRateMinor).toBeNull();
});

it("returns an empty overview when no locations qualify", async () => {
  reads.locations.mockResolvedValue([]);
  expect(await listPublicLocationsToday(now)).toEqual([]);
  expect(reads.hours).not.toHaveBeenCalled();
});

it("retains booking occupancy, past/closed slots and prices after the configuration extraction", async () => {
  reads.occupancy.mockResolvedValue([{ court_id: courtId, booking_date: "2026-10-15", starts_at_minute: 750, ends_at_minute: 810 }]);
  const day = await getPublicCourtDay(location, "2026-10-15", "2026-10-15", now);
  expect(day.times).toEqual([480, 510, 540, 570, 600, 630, 660, 690, 720, 750, 780]);
  expect(day.courts[0].cells).toEqual(["past", "past", "past", "past", "closed", "closed", "past", "past", "past", "booked", "booked"]);
  expect(day.courts[0].hourlyPrices).toEqual(Array(11).fill(null));
  expect(day.courts[0].rates).toEqual([5000, 5000, 5000, 5000, null, null, 5000, 5000, 5000, 5000, null]);
  expect((await listPublicLocationsToday(now))[0].startingRateMinor).toBe(5000);
  const future = await getPublicCourtDay(location, "2026-10-15", "2026-10-14", now);
  expect(future.courts[0].cells).toEqual(["available", "available", "available", "available", "closed", "closed", "available", "available", "available", "booked", "booked"]);
  expect(future.courts[0].hourlyPrices).toEqual([5000, 5000, 5000, 5000, null, null, 5000, 5000, 5000, null, null]);
});

it.each(["hours", "coverage", "pricing", "occupancy"] as const)("keeps malformed %s fail-closed in booking reads", async (key) => {
  reads[key].mockResolvedValue([{}]);
  await expect(getPublicCourtDay(location, "2026-10-15", "2026-10-15", now)).rejects.toThrow("Unable to load court availability.");
  if (key !== "occupancy") await expect(listPublicLocationsToday(now)).rejects.toThrow("Unable to load courts.");
});
