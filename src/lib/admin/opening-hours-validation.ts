import { z } from "zod";

export const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Enter a time as HH:mm (00:00–24:00).");

export function timeToMinute(time: string): number {
  const value = timeSchema.parse(time);
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function minuteToTime(minute: number): string {
  z.number().int().min(0).max(1440).parse(minute);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export const openingIntervalSchema = z.object({
  id: z.uuid(), location_id: z.uuid(), schedule_id: z.uuid().optional(),
  starts_on: z.iso.date().optional(), ends_on: z.iso.date().nullable().optional(), weekday: z.number().int().min(0).max(6),
  opens_at_minute: z.number().int().min(0).max(1439),
  closes_at_minute: z.number().int().min(1).max(1440),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
}).refine((value) => value.opens_at_minute < value.closes_at_minute);
export type OpeningInterval = z.infer<typeof openingIntervalSchema>;
export const datedOpeningIntervalSchema = openingIntervalSchema.safeExtend({
  schedule_id: z.uuid(), starts_on: z.iso.date(), ends_on: z.iso.date().nullable(),
});
export type DatedOpeningInterval = z.infer<typeof datedOpeningIntervalSchema>;

const editorIntervalSchema = z.strictObject({
  opens_at: timeSchema.refine((value) => value !== "24:00", "Opening time must be before 24:00."),
  closes_at: timeSchema,
}).refine((value) => !timeSchema.safeParse(value.opens_at).success || !timeSchema.safeParse(value.closes_at).success
  || timeToMinute(value.opens_at) < timeToMinute(value.closes_at), {
  path: ["closes_at"], message: "Closing time must be after opening time.",
});
const hoursMutationFields = {
  location_id: z.uuid(),
  starts_on: z.iso.date().optional(), ends_on: z.union([z.iso.date(), z.literal(""), z.null()]).optional(),
  replace_ids: z.array(z.uuid()),
  rows: z.array(editorIntervalSchema.safeExtend({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Select at least one day.")
      .refine((days) => new Set(days).size === days.length, "Select each day only once."),
  })),
};
const existingScheduleFields = { schedule_id: z.uuid(), revision: z.number().int().positive() };
export const weeklyHoursMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...hoursMutationFields, operation: z.literal("create"), starts_on: z.iso.date(),
    adjustment: z.object({ id: z.uuid(), revision: z.number().int().positive() }).nullable().optional() }),
  z.strictObject({ ...hoursMutationFields, ...existingScheduleFields, operation: z.literal("update") }),
  z.strictObject({ location_id: z.uuid(), ...existingScheduleFields, operation: z.literal("delete") }),
]).superRefine((value, context) => {
  if (value.operation === "delete") return;
  if (value.starts_on && value.ends_on && value.ends_on < value.starts_on) context.addIssue({ code: "custom", path: ["ends_on"], message: "Valid until must be on or after valid from." });
  if (value.operation === "create" && value.replace_ids.length) context.addIssue({ code: "custom", path: ["replace_ids"], message: "A new schedule cannot replace existing intervals." });
  if (new Set(value.replace_ids).size !== value.replace_ids.length) context.addIssue({ code: "custom", path: ["replace_ids"], message: "Duplicate interval selection." });
  for (let day = 0; day < 7; day++) {
    const valid = value.rows.filter((row) => row.weekdays.includes(day) && editorIntervalSchema.safeParse({ opens_at: row.opens_at, closes_at: row.closes_at }).success)
      .map((row) => ({ start: timeToMinute(row.opens_at), end: timeToMinute(row.closes_at) })).sort((a, b) => a.start - b.start);
    if (valid.some((row, index) => index > 0 && row.start < valid[index - 1].end)) {
      context.addIssue({ code: "custom", path: ["rows"], message: `${weekdays[day]} intervals cannot overlap.` });
    }
  }
});
export type OpeningHoursMutation = z.infer<typeof weeklyHoursMutationSchema>;

export type OpeningHoursMutationResult =
  | { ok: true; intervals: OpeningInterval[]; schedules?: OpeningHoursSchedule[]; scheduleId?: string; pricingAdjusted?: boolean; missingPricing?: boolean }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap"; weekdays: number[] }
  | { ok: false; reason: "stale" | "period-overlap" }
  | { ok: false; reason: "not-found" | "archived" | "unchanged" };

export function openingHoursScheduleKey(intervals: readonly Pick<OpeningInterval, "weekday" | "opens_at_minute" | "closes_at_minute">[]) {
  return JSON.stringify(intervals.map((interval) => [interval.weekday, interval.opens_at_minute, interval.closes_at_minute])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
}

function weeklySchedule(locationId: string, intervals: readonly OpeningInterval[]) {
  return weekdays.map((label, weekday) => ({
    label, weekday,
    intervals: intervals.filter((interval) => interval.location_id === locationId && interval.weekday === weekday)
      .sort((a, b) => a.opens_at_minute - b.opens_at_minute || a.closes_at_minute - b.closes_at_minute || a.id.localeCompare(b.id)),
  }));
}

export function groupedWeeklySchedule(locationId: string, intervals: readonly OpeningInterval[]) {
  const groups: { weekdays: number[]; intervals: { opens_at_minute: number; closes_at_minute: number; ids: string[] }[] }[] = [];
  for (const day of weeklySchedule(locationId, intervals)) {
    const match = groups.find((group) => group.intervals.length === day.intervals.length &&
      group.intervals.every((interval, index) => interval.opens_at_minute === day.intervals[index].opens_at_minute &&
        interval.closes_at_minute === day.intervals[index].closes_at_minute));
    if (match) {
      match.weekdays.push(day.weekday);
      day.intervals.forEach((interval, index) => match.intervals[index].ids.push(interval.id));
    } else {
      groups.push({ weekdays: [day.weekday], intervals: day.intervals.map((interval) => ({
        opens_at_minute: interval.opens_at_minute, closes_at_minute: interval.closes_at_minute, ids: [interval.id],
      })) });
    }
  }
  return groups;
}

export function weekdayGroupLabel(days: readonly number[]) {
  if (days.length === 7) return "Daily";
  if (days.join() === "0,1,2,3,4") return "Mon–Fri";
  if (days.join() === "5,6") return "Sat–Sun";
  const short = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((day) => short[day]).join(", ");
}

export const openingHoursScheduleSchema = z.object({
  id: z.uuid(), location_id: z.uuid(), starts_on: z.iso.date(), ends_on: z.iso.date().nullable(),
  revision: z.number().int().positive(),
});
export type OpeningHoursSchedule = z.infer<typeof openingHoursScheduleSchema>;
export function scheduleStatus(schedule: Pick<OpeningHoursSchedule, "starts_on" | "ends_on">, today: string) {
  return schedule.starts_on > today ? "Scheduled" : schedule.ends_on && schedule.ends_on < today ? "History" : "Current";
}

/** Only a current policy may yield to a new future policy; scheduled policies need an explicit edit. */
export function planOpeningHoursPeriod(schedules: readonly OpeningHoursSchedule[], startsOn: string, endsOn: string | null, today: string, allowAdjustment = true) {
  const overlaps = schedules.filter((s) => (!s.ends_on || startsOn <= s.ends_on) && (!endsOn || s.starts_on <= endsOn));
  if (!overlaps.length) return { ok: true as const, adjustment: null };
  const current = overlaps[0];
  if (!allowAdjustment || overlaps.length !== 1 || startsOn <= today || scheduleStatus(current, today) !== "Current") {
    return { ok: false as const };
  }
  const ends_on = new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { ok: true as const, adjustment: { ...current, ends_on } };
}
