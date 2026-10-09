import { expect, it } from "vitest";
import { groupedWeeklySchedule, weekdayGroupLabel, type OpeningInterval, } from "../../../src/lib/admin/opening-hours-validation";

const location_id = "c6000000-0000-4000-8000-000000000011";
const row = (weekday: number, opens_at_minute = 420, closes_at_minute = 1440): OpeningInterval => ({
  id: crypto.randomUUID(), location_id, weekday, opens_at_minute, closes_at_minute,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
});

it("groups only complete matching schedules and preserves multiple intervals", () => {
  const rows = [0, 1, 2, 3, 4].flatMap((day) => [row(day, 420, 720), row(day, 840, 1440)]);
  rows.push(row(5, 480, 1320), row(6, 480, 1320));
  const groups = groupedWeeklySchedule(location_id, rows);
  expect(groups.map((group) => [weekdayGroupLabel(group.weekdays), group.intervals.length])).toEqual([
    ["Mon–Fri", 2], ["Sat–Sun", 1],
  ]);
  expect(groups[0].intervals.map((interval) => interval.ids.length)).toEqual([5, 5]);
  const split = groupedWeeklySchedule(location_id, rows.filter((interval) => interval.weekday !== 2 || interval.opens_at_minute !== 840));
  expect(split.some((group) => group.weekdays.includes(2) && group.weekdays.includes(0))).toBe(false);
  expect(weekdayGroupLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Daily");
});
