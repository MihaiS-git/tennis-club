import { expect, it } from "vitest";
import {
  groupedWeeklySchedule, minuteToTime, timeToMinute, weekdayGroupLabel, weeklyHoursMutationSchema,
  type OpeningInterval,
} from "../../../src/lib/admin/opening-hours-validation";

const location_id = "c6000000-0000-4000-8000-000000000011";
const input = { location_id, weekdays: [0, 1, 2, 3, 4], replace_ids: [], intervals: [{ opens_at: "07:00", closes_at: "24:00" }] };
const row = (weekday: number, opens_at_minute = 420, closes_at_minute = 1440): OpeningInterval => ({
  id: crypto.randomUUID(), location_id, weekday, opens_at_minute, closes_at_minute,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
});

it.each([["00:00", 0], ["07:00", 420], ["23:59", 1439], ["24:00", 1440]] as const)("round trips %s ↔ %i", (time, minute) => {
  expect(timeToMinute(time)).toBe(minute);
  expect(minuteToTime(minute)).toBe(time);
});

it("validates one weekly operation and permits adjacent intervals", () => {
  expect(weeklyHoursMutationSchema.safeParse(input).success).toBe(true);
  expect(weeklyHoursMutationSchema.safeParse({ ...input, intervals: [
    { opens_at: "07:00", closes_at: "16:00" }, { opens_at: "16:00", closes_at: "20:00" },
  ] }).success).toBe(true);
  for (const change of [
    { weekdays: [] }, { weekdays: [0, 0] }, { weekdays: [7] }, { intervals: [{ opens_at: "24:00", closes_at: "24:00" }] },
    { intervals: [{ opens_at: "07:00", closes_at: "07:00" }] }, { intervals: [{ opens_at: "7:00", closes_at: "12:00" }] },
    { intervals: [{ opens_at: "07:00", closes_at: "12:00" }, { opens_at: "11:30", closes_at: "14:00" }] },
    { created_at: "spoof" },
  ]) expect(weeklyHoursMutationSchema.safeParse({ ...input, ...change }).success).toBe(false);
  expect(weeklyHoursMutationSchema.safeParse({ ...input, replace_ids: [crypto.randomUUID()], intervals: [] }).success).toBe(true);
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
