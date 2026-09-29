import { expect, it } from "vitest";
import { minuteToTime, openingHoursMutationSchema, timeToMinute, weeklySchedule, type OpeningInterval } from "../../../src/lib/admin/opening-hours-validation";

const location_id = "c6000000-0000-4000-8000-000000000011";
const input = { location_id, weekday: 0, opens_at: "07:00", closes_at: "24:00" };

it.each([["00:00", 0], ["07:00", 420], ["23:59", 1439], ["24:00", 1440]] as const)("round trips %s ↔ %i", (time, minute) => {
  expect(timeToMinute(time)).toBe(minute); expect(minuteToTime(minute)).toBe(time);
});
it.each(["7:00", "24:01", "25:00", "12:60", "07:00:00", "", " 07:00"])("rejects malformed time %s without throwing from mutation validation", (time) => {
  expect(() => timeToMinute(time)).toThrow();
  expect(openingHoursMutationSchema.safeParse({ ...input, closes_at: time }).success).toBe(false);
});
it.each([-1, 1441, 0.5, NaN])("rejects invalid boundary %s", (minute) => expect(() => minuteToTime(minute)).toThrow());
it("accepts 24:00 only as a closing boundary and rejects invalid intervals and mass assignment", () => {
  expect(openingHoursMutationSchema.safeParse(input).success).toBe(true);
  for (const changes of [{ opens_at: "24:00" }, { closes_at: "07:00" }, { closes_at: "06:59" }, { weekday: -1 }, { weekday: 7 }, { updated_at: "spoof" }]) {
    expect(openingHoursMutationSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});
it("orders Monday through Sunday and intervals by time, filters locations, and represents closed days", () => {
  const row = (weekday: number, opens_at_minute: number, id: string, location = location_id): OpeningInterval => ({ id, location_id: location, weekday,
    opens_at_minute, closes_at_minute: opens_at_minute + 60, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" });
  const rows = [row(6, 600, "sun"), row(0, 900, "late"), row(0, 420, "early"), row(0, 0, "other", "other-location")];
  const schedule = weeklySchedule(location_id, rows);
  expect(schedule.map((day) => day.label)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  expect(schedule[0].intervals.map((interval) => interval.id)).toEqual(["early", "late"]);
  expect(schedule[1].intervals).toEqual([]); expect(rows[0].id).toBe("sun");
  expect(weeklySchedule(location_id, []).every((day) => day.intervals.length === 0)).toBe(true);
});
