import { localMinute, localStartInstant, localToday } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { resolveCoachAvailability, type AvailabilityException, type WeeklyAvailabilityInterval } from "./availability-schedule";

export type SelectorSchedule = {
  weekly: (WeeklyAvailabilityInterval & { valid_from: string; valid_until: string | null })[];
  exceptions: AvailabilityException[];
  schedules: { id: string; starts_on: string; ends_on: string | null }[];
  hours: { schedule_id: string; weekday: number; opens_at_minute: number; closes_at_minute: number }[];
};
const nextDate = (date: string) => date === "9999-12-31" ? "9999-12-32" : new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// Configuration eligibility, deliberately independent of court/coach occupancy and
// the selected timetable date. Public booking currently has no upper date limit.
// Partition at every validity/exception boundary, then inspect weekly occurrences
// in each constant configuration segment rather than scanning an unbounded horizon.
export function hasConfiguredLesson(input: SelectorSchedule & {
  locationId: string; timezone: string; durationMinutes: number; now: Date; until?: string;
}): boolean {
  const today = localToday(input.timezone, input.now);
  const until = input.until ?? "9999-12-31";
  const boundaries = new Set([today]);
  const add = (date: string) => { if (date >= today && date <= until) boundaries.add(date); };
  const end = (date: string | null) => { if (date && date < until) add(nextDate(date)); };
  for (const row of input.weekly) { add(row.valid_from); end(row.valid_until); }
  for (const row of input.schedules) { add(row.starts_on); end(row.ends_on); }
  for (const row of input.exceptions) { add(row.date); end(row.until_date ?? row.date); }
  const dates = [...boundaries].sort();
  for (let i = 0; i < dates.length; i++) {
    // Today plus two future weekly occurrences cover passed starts today
    // and a clock-change occurrence that cannot fit the priced elapsed duration.
    for (let date = dates[i], day = 0; day <= 14 && date <= until && (!dates[i + 1] || date < dates[i + 1]); day++, date = nextDate(date)) {
      const schedule = input.schedules.find(row => row.starts_on <= date && (!row.ends_on || row.ends_on >= date));
      if (!schedule) continue;
      const hours = input.hours.filter(row => row.schedule_id === schedule.id && row.weekday === mondayWeekday(date));
      const windows = resolveCoachAvailability({ date,
        weekly: input.weekly.filter(row => row.valid_from <= date && (!row.valid_until || row.valid_until >= date)),
        exceptions: input.exceptions, timezones: new Map([[input.locationId, input.timezone]]) });
      const merged: { start: number; end: number }[] = [];
      for (const window of windows) {
        const last = merged.at(-1);
        if (last && last.end >= window.start_minute) last.end = Math.max(last.end, window.end_minute);
        else merged.push({ start: window.start_minute, end: window.end_minute });
      }
      for (const window of merged) for (const hour of hours) {
        const first = Math.ceil(Math.max(window.start, hour.opens_at_minute,
          date === today ? localMinute(input.timezone, input.now) : 0) / 30) * 30;
        for (let start = first; start + input.durationMinutes <= Math.min(window.end, hour.closes_at_minute); start += 30) {
          const instant = Date.parse(localStartInstant(input.timezone, date, start));
          if (instant > input.now.getTime() && Date.parse(localStartInstant(input.timezone, date, start + input.durationMinutes)) - instant === input.durationMinutes * 60000) return true;
        }
      }
    }
  }
  return false;
}
