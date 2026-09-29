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

export const openingHoursMutationSchema = z.strictObject({
  id: z.uuid().optional(), location_id: z.uuid(),
  weekday: z.number().int().min(0).max(6),
  opens_at: timeSchema.refine((value) => value !== "24:00", "Opening time must be before 24:00."),
  closes_at: timeSchema,
}).refine((value) => !timeSchema.safeParse(value.opens_at).success || !timeSchema.safeParse(value.closes_at).success
  || timeToMinute(value.opens_at) < timeToMinute(value.closes_at), {
  path: ["closes_at"], message: "Closing time must be after opening time.",
});
export const openingHoursRemovalSchema = z.strictObject({ id: z.uuid(), location_id: z.uuid() });

export type OpeningHoursMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap" | "not-found" };

export function weeklySchedule(locationId: string, intervals: readonly OpeningInterval[]) {
  return weekdays.map((label, weekday) => ({
    label, weekday,
    intervals: intervals.filter((interval) => interval.location_id === locationId && interval.weekday === weekday)
      .sort((a, b) => a.opens_at_minute - b.opens_at_minute || a.closes_at_minute - b.closes_at_minute || a.id.localeCompare(b.id)),
  }));
}
