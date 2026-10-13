import { expect, it } from "vitest";
import { pricingHasFutureOccurrence, pricingOpeningHoursError } from "../../src/lib/pricing/resolution";

const location_id = "c7000000-0000-4000-8000-000000000011";
const hours = [0, 1, 2, 3, 4].flatMap((weekday) => [
  { location_id, weekday, opens_at_minute: 480, closes_at_minute: 720 },
  { location_id, weekday, opens_at_minute: 840, closes_at_minute: 1260 },
]).concat([{ location_id, weekday: 5, opens_at_minute: 480, closes_at_minute: 1440 }]);
const datedHours = hours.map((hour) => ({ ...hour, starts_on: "0001-01-01", ends_on: null }));
const check = (days: number[], start: number, end: number, schedule = datedHours) => pricingOpeningHoursError(schedule, {
  location_id, weekdays: days, starts_at_minute: start, ends_at_minute: end,
}, "2026-10-10");

it("accepts a 24:00 end boundary", () => {
  expect(check([5], 1260, 1440)).toBeNull();
});
it("rejects before opening with the affected days and schedule", () => {
  expect(check([0, 1, 2, 3, 4], 390, 540)).toContain("outside Monday–Friday opening hours");
});
it("rejects a split-hours closed gap", () => {
  expect(check([0, 1, 2, 3, 4], 660, 900)).toContain("crosses a closed period");
});
it("rejects a closed selected day even when another day is valid", () => {
  expect(check([0, 6], 900, 960)).toContain("Sunday is closed");
});
it("checks different weekday schedules independently", () => {
  expect(check([0, 5], 1200, 1320)).toContain("Monday opening hours");
  expect(check([5], 1200, 1320)).toBeNull();
});
it("requires configured opening hours", () => {
  expect(check([0], 540, 600, [])).toBe("Configure this location's opening hours before saving pricing.");
});

it("only future matching weekdays retain an opening-hours dependency", () => {
  const rule = { weekday: 0, starts_on: null, ends_on: null };
  expect(pricingHasFutureOccurrence(rule, "2026-10-06")).toBe(true);
  expect(pricingHasFutureOccurrence({ ...rule, ends_on: "2026-10-12" }, "2026-10-06")).toBe(true);
  expect(pricingHasFutureOccurrence({ ...rule, ends_on: "2026-10-11" }, "2026-10-06")).toBe(false);
  expect(pricingHasFutureOccurrence({ ...rule, starts_on: "2026-10-13", ends_on: "2026-10-18" }, "2026-10-06")).toBe(false);
  expect(pricingHasFutureOccurrence({ ...rule, ends_on: "2026-10-05" }, "2026-10-06")).toBe(false);
});


it("validates optional pricing dates from today, retains historical contracts, and rejects future closed gaps", () => {
  const current = hours.map((h) => ({ ...h, starts_on: "2026-10-10", ends_on: null }));
  const input = { location_id, weekdays: [0], starts_at_minute: 480, ends_at_minute: 720 };
  expect(pricingOpeningHoursError(current,input,"2026-10-10")).toBeNull();
  expect(pricingOpeningHoursError(current,{ ...input, starts_on: "2026-01-01", ends_on: "2026-01-31" },"2026-10-10")).toBeNull();
  const gap = [...current.map((h) => ({ ...h, ends_on: "2026-10-18" })), ...current.map((h) => ({ ...h, starts_on: "2026-10-27" }))];
  expect(pricingOpeningHoursError(gap,input,"2026-10-10")).toContain("closed");
  expect(pricingOpeningHoursError(gap,{ ...input, ends_on: "2026-10-18" },"2026-10-10")).toBeNull();
});
