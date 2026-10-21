import { localStartInstant } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { scheduleStatus } from "@/lib/admin/opening-hours-validation";
import type { CoachAvailabilityExceptionKind } from "./availability-validation";

export type WeeklyAvailabilityInterval = { location_id: string; weekday: number; start_minute: number; end_minute: number };
export type AvailabilityException = {
  date: string; until_date?: string; kind: CoachAvailabilityExceptionKind; location_id: string | null; start_minute: number | null; end_minute: number | null;
};
export type CoachAvailabilityWindow = {
  location_id: string; date: string; start_minute: number; end_minute: number;
  starts_at: string; ends_at: string; source: "weekly" | "exception";
};

function exceptionRange(exception: AvailabilityException) {
  return { start: exception.start_minute ?? 0, end: exception.end_minute ?? 1440 };
}

function subtract(segment: { start: number; end: number }, cuts: readonly { start: number; end: number }[]) {
  let remaining = [segment];
  for (const cut of cuts) {
    remaining = remaining.flatMap((part) => cut.end <= part.start || cut.start >= part.end ? [part] : [
      ...(part.start < cut.start ? [{ start: part.start, end: cut.start }] : []),
      ...(cut.end < part.end ? [{ start: cut.end, end: part.end }] : []),
    ]);
  }
  return remaining;
}

// Deterministic coach availability on one local date. Every exception overrides
// the weekly schedule for its interval: "unavailable" removes it at every location,
// "available" replaces it with that location. Minutes are wall time at each window's
// location, converted with that location's timezone (DST-skipped time collapses).
// Locations without a timezone are omitted: callers pass only locations they accept.
// This is coach availability only, never a bookable lesson slot.
export function resolveCoachAvailability(input: {
  date: string;
  weekly: readonly WeeklyAvailabilityInterval[];
  exceptions: readonly AvailabilityException[];
  timezones: ReadonlyMap<string, string>;
}): CoachAvailabilityWindow[] {
  const weekday = mondayWeekday(input.date);
  const exceptions = input.exceptions.filter((exception) => exception.date <= input.date && (exception.until_date ?? exception.date) >= input.date);
  const cuts = exceptions.map(exceptionRange);
  const segments = [
    ...input.weekly.filter((interval) => interval.weekday === weekday).flatMap((interval) =>
      subtract({ start: interval.start_minute, end: interval.end_minute }, cuts)
        .map((part) => ({ location_id: interval.location_id, ...part, source: "weekly" as const }))),
    ...exceptions.filter((exception) => exception.kind === "available" && exception.location_id !== null)
      .map((exception) => ({ location_id: exception.location_id as string, ...exceptionRange(exception), source: "exception" as const })),
  ];
  return segments.flatMap((segment) => {
    const timezone = input.timezones.get(segment.location_id);
    if (!timezone) return [];
    const startsAt = localStartInstant(timezone, input.date, segment.start);
    const endsAt = localStartInstant(timezone, input.date, segment.end);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return [];
    return [{ location_id: segment.location_id, date: input.date, start_minute: segment.start, end_minute: segment.end,
      starts_at: startsAt, ends_at: endsAt, source: segment.source }];
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.location_id.localeCompare(b.location_id));
}

export type LocationOpeningSchedule = {
  starts_on: string; ends_on: string | null; status: "current" | "scheduled";
  intervals: { weekday: number; opens_at_minute: number; closes_at_minute: number }[];
};

// The schedule in effect on the location's local date and any later dated schedules,
// using the same inclusive date-range rule as opening-hours resolution. History is dropped.
export function currentAndUpcomingOpeningHours(
  schedules: readonly { id: string; starts_on: string; ends_on: string | null }[],
  hours: readonly { schedule_id: string; weekday: number; opens_at_minute: number; closes_at_minute: number }[],
  today: string,
): LocationOpeningSchedule[] {
  return schedules.filter((schedule) => scheduleStatus(schedule, today) !== "History")
    .toSorted((a, b) => a.starts_on.localeCompare(b.starts_on))
    .map((schedule) => ({
      starts_on: schedule.starts_on, ends_on: schedule.ends_on,
      status: scheduleStatus(schedule, today) === "Current" ? "current" : "scheduled",
      intervals: hours.filter((row) => row.schedule_id === schedule.id)
        .map(({ weekday, opens_at_minute, closes_at_minute }) => ({ weekday, opens_at_minute, closes_at_minute }))
        .toSorted((a, b) => a.weekday - b.weekday || a.opens_at_minute - b.opens_at_minute),
    }));
}
