import { z } from "zod";

// Coach availability uses minutes from local midnight at the interval's location,
// like location opening hours, on 30-minute boundaries. Weekdays are Monday-first (0–6).
const availabilityStepMinutes = 30;
export const availabilityWeekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const coachAvailabilityExceptionKinds = ["unavailable", "available"] as const;
export type CoachAvailabilityExceptionKind = typeof coachAvailabilityExceptionKinds[number];
// Exceptions are planned at most this many days ahead.
export const availabilityExceptionHorizonDays = 366;

export function formatAvailabilityMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function formatAvailabilityRange(start: number, end: number) {
  return `${formatAvailabilityMinute(start)}–${formatAvailabilityMinute(end)}`;
}

export const availabilityMinuteOptions = Array.from({ length: 1440 / availabilityStepMinutes + 1 }, (_, index) => index * availabilityStepMinutes);

const startMinute = z.number("Select a start time.").int().min(0, "Select a start time.").max(1440 - availabilityStepMinutes, "Start before 24:00.")
  .refine((minute) => minute % availabilityStepMinutes === 0, "Use 30-minute boundaries.");
const endMinute = z.number("Select an end time.").int().min(availabilityStepMinutes, "Select an end time.").max(1440, "End by 24:00.")
  .refine((minute) => minute % availabilityStepMinutes === 0, "Use 30-minute boundaries.");

function orderedRange(value: { start_minute: number | null; end_minute: number | null }, context: z.RefinementCtx) {
  if (value.start_minute !== null && value.end_minute !== null && value.start_minute >= value.end_minute) {
    context.addIssue({ code: "custom", path: ["end_minute"], message: "End time must be after start time." });
  }
}

// Working hours apply from valid_from (default: the location's today, or the edited
// row's start) until the inclusive valid_until; null or "" means no end date.
const validityFields = {
  valid_from: z.iso.date("Select a start date.").optional(),
  valid_until: z.union([z.iso.date("Select an end date."), z.literal(""), z.null()]).optional(),
};

function orderedValidity(value: { valid_from?: string; valid_until?: string | null }, context: z.RefinementCtx) {
  if (value.valid_from && value.valid_until && value.valid_until < value.valid_from) {
    context.addIssue({ code: "custom", path: ["valid_until"], message: "Until date must be on or after From date." });
  }
}

export const weeklyAvailabilityFieldsSchema = z.strictObject({
  location_id: z.uuid("Select a location."),
  weekday: z.number().int().min(0).max(6, "Select a day."),
  start_minute: startMinute,
  end_minute: endMinute,
  ...validityFields,
}).superRefine((value, context) => { orderedRange(value, context); orderedValidity(value, context); });

// One interval added on several weekdays at once; any combination, at least one.
export const weeklyAvailabilityBatchFieldsSchema = z.strictObject({
  location_id: z.uuid("Select a location."),
  weekdays: z.array(z.number().int().min(0).max(6, "Select a day.")).min(1, "Select at least one day.").max(7)
    .refine((weekdays) => new Set(weekdays).size === weekdays.length, "Select each day once."),
  start_minute: startMinute,
  end_minute: endMinute,
  ...validityFields,
}).superRefine((value, context) => { orderedRange(value, context); orderedValidity(value, context); });

// A whole-day or interval absence is coach-wide; extra availability names its location.
export const availabilityExceptionFieldsSchema = z.strictObject({
  date: z.iso.date("Select a date."),
  until_date: z.iso.date("Select an until date.").optional(),
  kind: z.enum(coachAvailabilityExceptionKinds, "Select an exception type."),
  location_id: z.uuid("Select a location.").nullable(),
  start_minute: startMinute.nullable(),
  end_minute: endMinute.nullable(),
  note: z.string().trim().max(200, "Use at most 200 characters."),
}).superRefine((value, context) => {
  orderedRange(value, context);
  const until = value.until_date ?? value.date;
  if (until < value.date) context.addIssue({ code: "custom", path: ["until_date"], message: "Until date must be on or after From date." });
  if (until !== value.date && (value.kind !== "unavailable" || value.start_minute !== null || value.end_minute !== null)) {
    context.addIssue({ code: "custom", path: ["until_date"], message: "Multi-day periods must be whole-day time off." });
  }
  if ((value.start_minute === null) !== (value.end_minute === null)) {
    context.addIssue({ code: "custom", path: [value.start_minute === null ? "start_minute" : "end_minute"], message: "Enter both times, or neither for the whole day." });
  }
  if (value.kind === "available") {
    if (value.location_id === null) context.addIssue({ code: "custom", path: ["location_id"], message: "Select a location." });
    if (value.start_minute === null && value.end_minute === null) context.addIssue({ code: "custom", path: ["start_minute"], message: "Additional availability needs a time interval." });
  } else if (value.location_id !== null) {
    context.addIssue({ code: "custom", path: ["location_id"], message: "Unavailability applies at every location." });
  }
});

export const availabilityChangeSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("save-weekly"), id: z.uuid().optional(), fields: weeklyAvailabilityFieldsSchema }),
  z.strictObject({ operation: z.literal("add-weekly"), fields: weeklyAvailabilityBatchFieldsSchema }),
  z.strictObject({ operation: z.literal("remove-weekly"), id: z.uuid() }),
  z.strictObject({ operation: z.literal("save-exception"), id: z.uuid().optional(), fields: availabilityExceptionFieldsSchema }),
  z.strictObject({ operation: z.literal("remove-exception"), id: z.uuid() }),
]);
export type AvailabilityChange = z.output<typeof availabilityChangeSchema>;

// Admins name the coach; coaches only ever change their own schedule.
export const adminAvailabilityChangeSchema = z.strictObject({ coach_user_id: z.uuid(), change: availabilityChangeSchema });

// "add-weekly" returns every created id (in weekday order) and, on overlap, the conflicting weekdays.
export type AvailabilityMutationResult =
  | { ok: true; id: string; ids?: string[] }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap"; weekdays?: number[] }
  // Working hours must lie inside the location's opening hours on every date they apply.
  | { ok: false; reason: "outside-opening-hours"; weekdays: number[] }
  | { ok: false; reason: "not-found" | "not-eligible" | "invalid-location" | "out-of-range" | "booking-conflict" };

export const availabilityFailureMessages: Record<Exclude<AvailabilityMutationResult, { ok: true } | { reason: "invalid-input" }>["reason"], string> = {
  "outside-opening-hours": "Working hours must be within the location's opening hours on every date they apply. Choose other times or end them earlier.",
  "booking-conflict": "This period conflicts with an existing coaching booking or payment hold. Resolve the booking before changing availability. No bookings were changed.",
  "not-found": "This availability no longer exists. Refresh the page.",
  "not-eligible": "Availability can only be changed for an active account with the Coach role and a coaching profile.",
  "invalid-location": "Select a current location this coach is assigned to.",
  "overlap": "This overlaps other availability for this coach, at this or another location.",
  "out-of-range": `Choose a date from today up to ${availabilityExceptionHorizonDays} days ahead. Past exceptions cannot be changed.`,
};

export function availabilityOverlapMessage(weekdays: readonly number[] | undefined) {
  if (!weekdays?.length) return availabilityFailureMessages.overlap;
  return `This overlaps existing availability on ${weekdays.map((weekday) => availabilityWeekdays[weekday]).join(", ")}. Nothing was saved.`;
}

export function availabilityOutsideOpeningHoursMessage(weekdays: readonly number[]) {
  if (!weekdays.length) return availabilityFailureMessages["outside-opening-hours"];
  return `Outside the location's opening hours on ${weekdays.map((weekday) => availabilityWeekdays[weekday]).join(", ")} for the selected dates. Choose other times or end them earlier. Nothing was saved.`;
}

export function availabilityFieldErrors(issues: readonly z.core.$ZodIssue[]) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path.find((part) => typeof part === "string" && part !== "fields" && part !== "change");
    fieldErrors[String(field ?? "form")] ??= issue.message;
  }
  return fieldErrors;
}

export function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start < b.end && b.start < a.end;
}
