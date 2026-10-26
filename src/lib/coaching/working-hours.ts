import { addDays } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";

// A coach's weekly working hours at a location must lie inside that location's opening
// hours on every date they apply to. Opening hours are effective-dated schedules, so
// working hours carry their own inclusive validity dates (an open end is unbounded) and
// are checked and reconciled per schedule period. Dates covered by no schedule are closed.
// Minutes are local wall time on the 30-minute availability grid.

export type OpeningPeriod = {
  starts_on: string; ends_on: string | null;
  intervals: readonly { weekday: number; opens_at_minute: number; closes_at_minute: number }[];
};
export type DatedWorkingHours = { weekday: number; start_minute: number; end_minute: number; valid_from: string; valid_until: string | null };
export type DateRange = { from: string; until: string | null };
type Window = { start: number; end: number };

const gridMinutes = 30;

const before = (a: string | null, b: string | null) => a !== null && (b === null || a < b);
const minDate = (a: string | null, b: string | null) => before(a, b) ? a : b;

// Parts of `a` outside `b`, both inclusive.
export function dateRangeDifference(a: DateRange, b: DateRange): DateRange[] {
  const parts: DateRange[] = [];
  if (a.from < b.from) parts.push({ from: a.from, until: minDate(a.until, addDays(b.from, -1)) });
  if (b.until !== null && before(b.until, a.until)) parts.push({ from: b.until < a.from ? a.from : addDays(b.until, 1), until: a.until });
  return parts.filter((part) => part.until === null || part.from <= part.until);
}

// Whether the weekday occurs at least once in the inclusive range.
function occurs(range: DateRange, weekday: number) {
  if (range.until === null || addDays(range.from, 6) <= range.until) return true;
  for (let date = range.from; date <= range.until; date = addDays(date, 1)) if (mondayWeekday(date) === weekday) return true;
  return false;
}

// Opening intervals of one weekday, joined where they touch and narrowed to the grid.
function openingWindows(period: OpeningPeriod, weekday: number): Window[] {
  const merged: Window[] = [];
  for (const interval of period.intervals.filter((row) => row.weekday === weekday).toSorted((a, b) => a.opens_at_minute - b.opens_at_minute)) {
    const last = merged.at(-1);
    if (last && last.end >= interval.opens_at_minute) last.end = Math.max(last.end, interval.closes_at_minute);
    else merged.push({ start: interval.opens_at_minute, end: interval.closes_at_minute });
  }
  return merged.map((window) => ({ start: Math.ceil(window.start / gridMinutes) * gridMinutes, end: Math.floor(window.end / gridMinutes) * gridMinutes }))
    .filter((window) => window.start < window.end);
}

function intersect(windows: readonly Window[], other: readonly Window[]) {
  return windows.flatMap((a) => other.map((b) => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })))
    .filter((window) => window.start < window.end).sort((a, b) => a.start - b.start);
}

// Consecutive pieces of a date range, each in one schedule period or in a closed gap.
function periodSegments(range: DateRange, periods: readonly OpeningPeriod[]) {
  const sorted = periods.toSorted((a, b) => a.starts_on.localeCompare(b.starts_on));
  const segments: (DateRange & { period: OpeningPeriod | null })[] = [];
  let from: string | null = range.from;
  while (from !== null && (range.until === null || from <= range.until)) {
    const cursor: string = from;
    const period = sorted.find((p) => p.starts_on <= cursor && (p.ends_on === null || cursor <= p.ends_on)) ?? null;
    const next = sorted.find((p) => p.starts_on > cursor);
    const end = period ? period.ends_on : next ? addDays(next.starts_on, -1) : null;
    const until = minDate(end, range.until);
    segments.push({ from: cursor, until, period });
    from = until === null ? null : addDays(until, 1);
  }
  return segments;
}

// The minute windows open on this weekday throughout the range: the intersection of
// every applicable period's opening hours, ignoring parts where the weekday never occurs.
export function openOnWeekdayThroughout(range: DateRange, periods: readonly OpeningPeriod[], weekday: number): Window[] {
  return periodSegments(range, periods).filter((segment) => occurs(segment, weekday))
    .reduce<Window[]>((open, segment) => intersect(open, segment.period ? openingWindows(segment.period, weekday) : []), [{ start: 0, end: 1440 }]);
}

// The opening intervals applying on one date; none when no schedule covers it.
export function openingIntervalsOn(periods: readonly OpeningPeriod[], date: string) {
  return periods.find((period) => period.starts_on <= date && (period.ends_on === null || date <= period.ends_on))?.intervals ?? [];
}

export function isWithinOpeningHours(hours: DatedWorkingHours, periods: readonly OpeningPeriod[]) {
  return openOnWeekdayThroughout({ from: hours.valid_from, until: hours.valid_until }, periods, hours.weekday)
    .some((window) => window.start <= hours.start_minute && hours.end_minute <= window.end);
}

// The replacement of one row so that it fits the opening hours on the `affected` dates.
// Other dates keep the row's hours. Trimming keeps only the valid intersection (possibly
// several intervals), never adds time, and splits the row's dates where the result differs.
export function fitWorkingHours(hours: DatedWorkingHours, periods: readonly OpeningPeriod[], affected: readonly DateRange[]): DatedWorkingHours[] {
  const own: Window = { start: hours.start_minute, end: hours.end_minute };
  const range = { from: hours.valid_from, until: hours.valid_until };
  // Boundaries of affected ranges inside the row split it into affected/unaffected parts.
  const cuts = new Set<string>();
  for (const part of affected) {
    if (part.from > range.from && (range.until === null || part.from <= range.until)) cuts.add(part.from);
    if (part.until !== null && part.until >= range.from && before(part.until, range.until)) cuts.add(addDays(part.until, 1));
  }
  const starts = [range.from, ...[...cuts].sort()];
  const segments = starts.flatMap((from, index) => {
    const part = { from, until: index + 1 < starts.length ? addDays(starts[index + 1], -1) : range.until };
    const inAffected = affected.some((a) => a.from <= part.from && (a.until === null || (part.until !== null && part.until <= a.until)));
    if (!inAffected) return [{ ...part, windows: [own] as Window[] | null }];
    return periodSegments(part, periods).map((segment) => ({ from: segment.from, until: segment.until,
      windows: segment.period ? intersect([own], openingWindows(segment.period, hours.weekday)) : [] }));
  }).map((segment) => occurs(segment, hours.weekday) ? segment : { ...segment, windows: null });

  // Dates on which the weekday never occurs follow their neighbours instead of splitting.
  if (segments.every((segment) => segment.windows === null)) return [hours];
  segments.forEach((segment, index) => { if (segment.windows === null) segment.windows = segments[index - 1]?.windows ?? null; });
  for (let index = segments.length - 1; index >= 0; index--) segments[index].windows ??= segments[index + 1].windows;

  const result: DatedWorkingHours[] = [];
  let open: DatedWorkingHours[] = [];
  for (const segment of segments) {
    open = (segment.windows ?? []).map((window) => {
      const run = open.find((row) => row.start_minute === window.start && row.end_minute === window.end);
      if (run) { run.valid_until = segment.until; return run; }
      const row = { weekday: hours.weekday, start_minute: window.start, end_minute: window.end, valid_from: segment.from, valid_until: segment.until };
      result.push(row);
      return row;
    });
  }
  return result.sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.start_minute - b.start_minute);
}

function sameWorkingHours(a: DatedWorkingHours, b: DatedWorkingHours) {
  return a.weekday === b.weekday && a.start_minute === b.start_minute && a.end_minute === b.end_minute
    && a.valid_from === b.valid_from && a.valid_until === b.valid_until;
}

// Dates whose opening hours an opening-hours change can alter: the union of a schedule's
// old and new periods when its hours change, otherwise only dates entering or leaving it.
export function changedOpeningDates(changes: readonly { before: DateRange | null; after: DateRange | null; hoursChanged: boolean }[]) {
  return changes.flatMap(({ before: old, after, hoursChanged }) => {
    if (!old || !after) return [old ?? after].filter((range): range is DateRange => range !== null);
    if (hoursChanged) return [old, after];
    return [...dateRangeDifference(old, after), ...dateRangeDifference(after, old)];
  });
}

// Restricts ranges to dates on or after `from`.
export function fromDate(ranges: readonly DateRange[], from: string): DateRange[] {
  return ranges.filter((range) => range.until === null || range.until >= from)
    .map((range) => range.from < from ? { ...range, from } : range);
}

export type WorkingHoursReconciliation<T> = { unchanged: T[]; changed: { row: T; replacements: DatedWorkingHours[] }[] };

// Plans the reconciliation of working-hour rows at one location after its opening hours
// changed on the `affected` dates. Rows outside those dates are never touched.
export function planWorkingHoursReconciliation<T extends DatedWorkingHours>(rows: readonly T[], periods: readonly OpeningPeriod[],
  affected: readonly DateRange[]): WorkingHoursReconciliation<T> {
  const plan: WorkingHoursReconciliation<T> = { unchanged: [], changed: [] };
  for (const row of rows) {
    const replacements = fitWorkingHours(row, periods, affected);
    if (replacements.length === 1 && sameWorkingHours(replacements[0], row)) plan.unchanged.push(row);
    else plan.changed.push({ row, replacements });
  }
  return plan;
}
