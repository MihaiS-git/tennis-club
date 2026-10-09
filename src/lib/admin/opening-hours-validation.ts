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
  id: z.uuid(), location_id: z.uuid(), weekday: z.number().int().min(0).max(6),
  opens_at_minute: z.number().int().min(0).max(1439),
  closes_at_minute: z.number().int().min(1).max(1440),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
}).refine((value) => value.opens_at_minute < value.closes_at_minute);
export type OpeningInterval = z.infer<typeof openingIntervalSchema>;

export const editorIntervalSchema = z.strictObject({
  opens_at: timeSchema.refine((value) => value !== "24:00", "Opening time must be before 24:00."),
  closes_at: timeSchema,
}).refine((value) => !timeSchema.safeParse(value.opens_at).success || !timeSchema.safeParse(value.closes_at).success
  || timeToMinute(value.opens_at) < timeToMinute(value.closes_at), {
  path: ["closes_at"], message: "Closing time must be after opening time.",
});
export const weeklyHoursMutationSchema = z.strictObject({
  location_id: z.uuid(), weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  replace_ids: z.array(z.uuid()), intervals: z.array(editorIntervalSchema),
}).superRefine((value, context) => {
  if (new Set(value.weekdays).size !== value.weekdays.length) context.addIssue({ code: "custom", path: ["weekdays"], message: "Select each day only once." });
  if (new Set(value.replace_ids).size !== value.replace_ids.length) context.addIssue({ code: "custom", path: ["replace_ids"], message: "Duplicate interval selection." });
  if (value.intervals.length === 0 && value.replace_ids.length === 0) context.addIssue({ code: "custom", path: ["intervals"], message: "Add an interval." });
  const valid = value.intervals.filter((interval) => editorIntervalSchema.safeParse(interval).success)
    .map((interval) => ({ start: timeToMinute(interval.opens_at), end: timeToMinute(interval.closes_at) }))
    .sort((a, b) => a.start - b.start);
  if (valid.some((interval, index) => index > 0 && interval.start < valid[index - 1].end)) {
    context.addIssue({ code: "custom", path: ["intervals"], message: "Intervals cannot overlap." });
  }
});

export type OpeningHoursMutationResult =
  | { ok: true; intervals: OpeningInterval[] }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap"; weekdays: number[] }
  | { ok: false; reason: "pricing-conflict"; message: string }
  | { ok: false; reason: "not-found" | "archived" };

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
