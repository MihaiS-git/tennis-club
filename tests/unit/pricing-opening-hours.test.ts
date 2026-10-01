import { expect, it } from "vitest";
import { pricingOpeningHoursError } from "../../src/lib/pricing/resolution";

const location_id = "c7000000-0000-4000-8000-000000000011";
const hours = [0, 1, 2, 3, 4].flatMap((weekday) => [
  { location_id, weekday, opens_at_minute: 480, closes_at_minute: 720 },
  { location_id, weekday, opens_at_minute: 840, closes_at_minute: 1260 },
]).concat([{ location_id, weekday: 5, opens_at_minute: 480, closes_at_minute: 1440 }]);
const check = (days: number[], start: number, end: number, schedule = hours) => pricingOpeningHoursError(schedule, {
  location_id, weekdays: days, starts_at_minute: start, ends_at_minute: end,
});

it("accepts a 24:00 end boundary", () => {
  expect(check([5], 1260, 1440)).toBeNull();
});
it("rejects before opening with the affected days and schedule", () => {
  expect(check([0, 1, 2, 3, 4], 390, 540)).toBe("The selected time 06:30–09:00 is outside Monday–Friday opening hours (08:00–12:00, 14:00–21:00).");
});
it("rejects a split-hours closed gap", () => {
  expect(check([0, 1, 2, 3, 4], 660, 900)).toBe("The selected time 11:00–15:00 crosses a closed period. Monday–Friday are open 08:00–12:00 and 14:00–21:00.");
});
it("rejects a closed selected day even when another day is valid", () => {
  expect(check([0, 6], 900, 960)).toBe("Sunday is closed. Remove Sunday or change the location's opening hours.");
});
it("checks different weekday schedules independently", () => {
  expect(check([0, 5], 1200, 1320)).toContain("Monday opening hours");
  expect(check([5], 1200, 1320)).toBeNull();
});
it("requires configured opening hours", () => {
  expect(check([0], 540, 600, [])).toBe("Configure this location's opening hours before saving pricing.");
});
