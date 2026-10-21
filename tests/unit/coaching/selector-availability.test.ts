import { expect, it } from "vitest";
import { hasConfiguredLesson, type SelectorSchedule } from "@/lib/coaching/selector-availability";

const now = new Date("2026-10-20T08:00:00Z");
const weekly = { location_id: "riverside", weekday: 1, start_minute: 600, end_minute: 720, valid_from: "2026-01-01", valid_until: null };
const base: SelectorSchedule = { weekly: [weekly], exceptions: [], schedules: [{ id: "s", starts_on: "2026-01-01", ends_on: null }],
  hours: Array.from({ length: 7 }, (_, weekday) => ({ schedule_id: "s", weekday, opens_at_minute: 540, closes_at_minute: 1200 })) };
const check = (changes: Partial<SelectorSchedule & { locationId: string; durationMinutes: number; until: string; timezone: string }> = {}) =>
  hasConfiguredLesson({ ...base, locationId: "riverside", timezone: "UTC", now, durationMinutes: 60, ...changes });

it("excludes Central Club with no local hours and includes the same coach at Riverside", () => {
  expect(check({ locationId: "central" })).toBe(false);
  expect(check()).toBe(true);
});
it("rejects expired hours and accepts future hours only within the supplied booking range", () => {
  expect(check({ weekly: [{ ...weekly, valid_until: "2026-10-19" }] })).toBe(false);
  const future = [{ ...weekly, valid_from: "2026-11-01" }];
  expect(check({ weekly: future, until: "2026-11-10" })).toBe(true);
  expect(check({ weekly: future, until: "2026-10-31" })).toBe(false);
  // The existing public date range has no configured upper limit.
  expect(check({ weekly: [{ ...weekly, valid_from: "2099-01-01" }] })).toBe(true);
});
it("does not depend on the selected date or occupancy", () => {
  // Only Wednesday hours, so no configured time today (Tuesday).
  expect(check({ weekly: [{ ...weekly, weekday: 2 }] })).toBe(true);
});
it("requires enough contiguous working time inside effective opening hours", () => {
  expect(check({ durationMinutes: 150 })).toBe(false);
  expect(check({ hours: base.hours.map(row => ({ ...row, opens_at_minute: 690 })) })).toBe(false);
  expect(check({ schedules: [{ id: "s", starts_on: "2026-11-01", ends_on: null }], weekly: [{ ...weekly, valid_until: "2026-10-31" }] })).toBe(false);
  expect(check({ weekly: [{ ...weekly, end_minute: 630 }, { ...weekly, start_minute: 630, end_minute: 660 }] })).toBe(true);
});
it("includes local extra hours without regular hours; time off and other-location extras never create local availability", () => {
  const extra = { date: "2026-10-21", kind: "available" as const, location_id: "riverside", start_minute: 600, end_minute: 660 };
  expect(check({ weekly: [], exceptions: [extra] })).toBe(true);
  expect(check({ weekly: [], exceptions: [{ ...extra, location_id: "central" }] })).toBe(false);
  expect(check({ weekly: [], exceptions: [{ ...extra, kind: "unavailable" }] })).toBe(false);
  expect(check({ weekly: [], exceptions: [extra], durationMinutes: 90 })).toBe(false);
  expect(check({ weekly: [], exceptions: [extra], until: "2026-10-20" })).toBe(false);
});
it("respects multi-day time off and replacement extras at another location", () => {
  expect(check({ exceptions: [{ date: "2026-01-01", until_date: "9999-12-31", kind: "unavailable", location_id: null, start_minute: null, end_minute: null }] })).toBe(false);
  expect(check({ weekly: [{ ...weekly, valid_until: "2026-10-20" }], exceptions: [{ date: "2026-10-20", kind: "available", location_id: "central", start_minute: 600, end_minute: 720 }] })).toBe(false);
});
it("uses location-local today and rejects passed one-off availability", () => {
  expect(check({ weekly: [], timezone: "Europe/Bucharest", exceptions: [{ date: "2026-10-20", kind: "available", location_id: "riverside", start_minute: 600, end_minute: 660 }] })).toBe(false);
});

it("finds the following weekly occurrence when today has passed and next week crosses DST", () => {
  expect(hasConfiguredLesson({ ...base, now: new Date("2026-03-22T06:00:00Z"), locationId: "riverside", timezone: "Europe/Bucharest",
    durationMinutes: 120, weekly: [{ ...weekly, weekday: 6, start_minute: 180, end_minute: 300 }],
    hours: base.hours.map(row => ({ ...row, opens_at_minute: 0 })) })).toBe(true);
});
