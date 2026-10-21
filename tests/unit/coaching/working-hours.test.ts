import { describe, expect, it } from "vitest";
import {
  changedOpeningDates, dateRangeDifference, fitWorkingHours, fromDate, isWithinOpeningHours, openingIntervalsOn, openOnWeekdayThroughout,
  planWorkingHoursReconciliation, type OpeningPeriod,
} from "@/lib/coaching/working-hours";

const daily = (opens: number, closes: number, days = [0, 1, 2, 3, 4, 5, 6]) =>
  days.map((weekday) => ({ weekday, opens_at_minute: opens, closes_at_minute: closes }));
const period = (starts_on: string, ends_on: string | null, intervals: OpeningPeriod["intervals"]): OpeningPeriod => ({ starts_on, ends_on, intervals });
// Monday working hours from 2030-01-07 (a Monday), without an end.
const monday = (start: number, end: number, valid_from = "2030-01-07", valid_until: string | null = null) =>
  ({ weekday: 0, start_minute: start, end_minute: end, valid_from, valid_until });
const all = [{ from: "0001-01-01", until: null }];

describe("opening-hours containment", () => {
  const current = period("0001-01-01", null, [...daily(480, 1320, [0, 1, 2, 3, 4]), ...daily(540, 1260, [5])]);

  it("accepts both split-day intervals independently on every weekday and rejects crossing lunch", () => {
    const weekdays = [0, 1, 2, 3, 4];
    const lunch = [period("0001-01-01", null, [...daily(480, 720, weekdays), ...daily(840, 1260, weekdays)])];
    for (const weekday of weekdays) {
      expect(isWithinOpeningHours({ ...monday(480, 720), weekday }, lunch)).toBe(true);
      expect(isWithinOpeningHours({ ...monday(840, 1260), weekday }, lunch)).toBe(true);
      expect(isWithinOpeningHours({ ...monday(660, 900), weekday }, lunch)).toBe(false);
    }
  });

  it("accepts hours inside the opening hours and rejects hours outside them or on a closed weekday", () => {
    expect(isWithinOpeningHours(monday(480, 1320), [current])).toBe(true);
    expect(isWithinOpeningHours(monday(450, 600), [current])).toBe(false);
    expect(isWithinOpeningHours(monday(1260, 1350), [current])).toBe(false);
    expect(isWithinOpeningHours({ ...monday(600, 660), weekday: 6 }, [current])).toBe(false);
    expect(isWithinOpeningHours({ ...monday(540, 1260), weekday: 5 }, [current])).toBe(true);
  });

  it("checks every applicable effective-dated period and treats uncovered dates as closed", () => {
    const periods = [period("0001-01-01", "2030-10-31", daily(420, 1320)), period("2030-11-01", null, daily(540, 1200))];
    expect(isWithinOpeningHours(monday(480, 1260, "2030-01-07", "2030-10-31"), periods)).toBe(true);
    expect(isWithinOpeningHours(monday(480, 1260), periods)).toBe(false);
    expect(isWithinOpeningHours(monday(540, 1200), periods)).toBe(true);
    const bounded = [period("0001-01-01", "2030-10-31", daily(420, 1320))];
    expect(isWithinOpeningHours(monday(540, 1200), bounded)).toBe(false);
    expect(isWithinOpeningHours(monday(540, 1200, "2030-01-07", "2030-10-31"), bounded)).toBe(true);
    expect(isWithinOpeningHours(monday(540, 600), [])).toBe(false);
  });

  it("finds the intervals applying on a date, none in an uncovered gap", () => {
    const periods = [period("0001-01-01", "2030-10-31", daily(420, 1320, [0])), period("2030-11-03", null, daily(540, 1200, [0]))];
    expect(openingIntervalsOn(periods, "2030-10-31")).toEqual(daily(420, 1320, [0]));
    expect(openingIntervalsOn(periods, "2030-11-01")).toEqual([]);
    expect(openingIntervalsOn(periods, "2031-01-06")).toEqual(daily(540, 1200, [0]));
  });

  it("joins touching opening intervals and keeps hours on the 30-minute grid", () => {
    const split = period("0001-01-01", null, [...daily(480, 720, [0]), ...daily(720, 1200, [0])]);
    expect(isWithinOpeningHours(monday(600, 900), [split])).toBe(true);
    const offGrid = period("0001-01-01", null, daily(435, 1275, [0]));
    expect(openOnWeekdayThroughout({ from: "2030-01-07", until: null }, [offGrid], 0)).toEqual([{ start: 450, end: 1260 }]);
  });
});

describe("working-hours reconciliation", () => {
  it("trims hours partially outside new opening hours to the intersection", () => {
    // Location 07:00–22:00 → 09:00–20:00; coach 08:00–21:00 → 09:00–20:00.
    expect(fitWorkingHours(monday(480, 1260), [period("0001-01-01", null, daily(540, 1200))], all)).toEqual([monday(540, 1200)]);
  });

  it("keeps hours inside, removes hours entirely outside and on closed days", () => {
    const hours = [period("0001-01-01", null, daily(540, 1200, [1, 2, 3, 4, 5, 6]))];
    expect(fitWorkingHours({ ...monday(600, 660), weekday: 1 }, hours, all)).toEqual([{ ...monday(600, 660), weekday: 1 }]);
    expect(fitWorkingHours({ ...monday(1200, 1320), weekday: 1 }, hours, all)).toEqual([]);
    expect(fitWorkingHours(monday(600, 660), hours, all)).toEqual([]);
  });

  it("preserves separate valid intervals without adding time", () => {
    const lunch = [period("0001-01-01", null, [...daily(480, 720, [0]), ...daily(840, 1200, [0])])];
    expect(fitWorkingHours(monday(600, 1080), lunch, all)).toEqual([monday(600, 720), monday(840, 1080)]);
  });

  it("never extends hours when opening hours are extended", () => {
    expect(fitWorkingHours(monday(540, 1200), [period("0001-01-01", null, daily(420, 1320))], all)).toEqual([monday(540, 1200)]);
  });

  it("trims only the dates of a future schedule and splits the row there", () => {
    const periods = [period("0001-01-01", "2030-10-31", daily(420, 1320)), period("2030-11-01", null, daily(540, 1200))];
    expect(fitWorkingHours(monday(480, 1260), periods, [{ from: "2030-11-01", until: null }])).toEqual([
      monday(480, 1260, "2030-01-07", "2030-10-31"), monday(540, 1200, "2030-11-01", null),
    ]);
  });

  it("closes dates no longer covered by any schedule after a bounded future schedule", () => {
    const periods = [period("0001-01-01", "2030-10-31", daily(420, 1320)), period("2030-11-01", "2031-03-31", daily(540, 1200))];
    expect(fitWorkingHours(monday(480, 1260), periods, [{ from: "2030-11-01", until: null }])).toEqual([
      monday(480, 1260, "2030-01-07", "2030-10-31"), monday(540, 1200, "2030-11-01", "2031-03-31"),
    ]);
  });

  it("does not split hours for dates on which their weekday never occurs", () => {
    // A closed Tuesday–Thursday holiday period between two regular periods.
    const periods = [period("0001-01-01", "2030-12-23", daily(420, 1320)), period("2030-12-24", "2030-12-26", []),
      period("2030-12-27", null, daily(420, 1320))];
    const affected = [{ from: "2030-12-24", until: "2030-12-26" }];
    expect(fitWorkingHours(monday(480, 1260), periods, affected)).toEqual([monday(480, 1260)]);
    expect(fitWorkingHours({ ...monday(480, 1260), weekday: 1 }, periods, affected)).toEqual([
      { ...monday(480, 1260, "2030-01-07", "2030-12-23"), weekday: 1 }, { ...monday(480, 1260, "2030-12-27", null), weekday: 1 },
    ]);
  });

  it("leaves dates outside the changed period untouched", () => {
    const periods = [period("0001-01-01", "2030-10-31", daily(600, 660)), period("2030-11-01", null, daily(540, 1200))];
    // Only the future schedule changed: earlier dates keep their hours.
    expect(fitWorkingHours(monday(480, 1260), periods, [{ from: "2030-11-01", until: null }])[0]).toEqual(monday(480, 1260, "2030-01-07", "2030-10-31"));
  });

  it("plans each coach's rows independently and reports only changed rows", () => {
    const periods = [period("0001-01-01", null, daily(540, 1200))];
    const rows = [{ id: "a", ...monday(480, 1260) }, { id: "b", ...monday(600, 720) }, { id: "c", ...monday(1200, 1320) }];
    const plan = planWorkingHoursReconciliation(rows, periods, all);
    expect(plan.unchanged.map((row) => row.id)).toEqual(["b"]);
    expect(plan.changed.map(({ row, replacements }) => [row.id, replacements])).toEqual([["a", [monday(540, 1200)]], ["c", []]]);
  });
});

describe("changed opening dates", () => {
  it("covers both periods when hours change, and only moved dates otherwise", () => {
    const old = { from: "2030-01-01", until: "2030-06-30" };
    expect(changedOpeningDates([{ before: old, after: { from: "2030-02-01", until: "2030-08-31" }, hoursChanged: true }]))
      .toEqual([old, { from: "2030-02-01", until: "2030-08-31" }]);
    expect(changedOpeningDates([{ before: old, after: { from: "2030-02-01", until: "2030-08-31" }, hoursChanged: false }]))
      .toEqual([{ from: "2030-01-01", until: "2030-01-31" }, { from: "2030-07-01", until: "2030-08-31" }]);
    expect(changedOpeningDates([{ before: null, after: { from: "2030-11-01", until: null }, hoursChanged: true }])).toEqual([{ from: "2030-11-01", until: null }]);
    expect(changedOpeningDates([{ before: old, after: null, hoursChanged: false }])).toEqual([old]);
  });

  it("subtracts inclusive and unbounded ranges and starts at today", () => {
    expect(dateRangeDifference({ from: "0001-01-01", until: null }, { from: "0001-01-01", until: "2030-10-31" })).toEqual([{ from: "2030-11-01", until: null }]);
    expect(dateRangeDifference({ from: "2030-01-01", until: "2030-01-31" }, { from: "2030-01-01", until: null })).toEqual([]);
    expect(fromDate([{ from: "2020-01-01", until: "2020-12-31" }, { from: "2020-01-01", until: null }], "2026-10-20"))
      .toEqual([{ from: "2026-10-20", until: null }]);
  });
});
