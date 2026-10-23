import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { majorAmountSchema } from "@/lib/pricing/money";

export const coachingProgramTypes = ["private", "semi_private", "group", "junior"] as const;
export type CoachingProgramType = typeof coachingProgramTypes[number];
export function isOnlineCoachingProgramType(type: CoachingProgramType): type is "private" | "semi_private" {
  return type === "private" || type === "semi_private";
}
export const coachingProgramTypeLabels: Record<CoachingProgramType, string> = {
  private: "Private", semi_private: "Semi-private", group: "Group", junior: "Junior",
};

export const coachingProgramDurations = [60, 90, 120] as const;

export function isCoachingDuration(minutes: number) {
  return coachingProgramDurations.some(duration => duration === minutes);
}
export const coachingDurationSchema = z.number().int().refine(isCoachingDuration, "Select 60, 90 or 120 minutes.");

export function formatCoachingDuration(minutes: number) {
  return `${minutes} min`;
}

export function formatParticipants(min: number | null, max: number | null) {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) {
    if (min === max) return `${min} ${min === 1 ? "player" : "players"}`;
    return `${min}–${max} players`;
  }
  if (max !== null) return `Up to ${max} ${max === 1 ? "player" : "players"}`;
  return `At least ${min} ${min === 1 ? "player" : "players"}`;
}

// Free text lists (specialties, languages) are entered comma-separated.
export function parseTextList(value: string) {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim().replace(/\s+/g, " ");
    if (item && !seen.has(item.toLowerCase())) { seen.add(item.toLowerCase()); items.push(item); }
  }
  return items;
}

const optionalCount = z.union([z.null(), z.number().int().min(1, "Use at least 1.").max(100, "Use at most 100.")]);

export const coachingProgramFieldsSchema = z.strictObject({
  name: z.string().trim().min(1, "Enter a program name.").max(100, "Use at most 100 characters."),
  description: z.string().trim().max(2000, "Use at most 2,000 characters."),
  program_type: z.enum(coachingProgramTypes, "Select a program type."),
  durations: z.array(coachingDurationSchema)
    .min(1, "Add at least one duration.").max(coachingProgramDurations.length)
    .refine((durations) => new Set(durations).size === durations.length, "Each duration can be listed only once."),
  min_participants: optionalCount,
  max_participants: optionalCount,
  court_rental_included: z.boolean(),
  is_active: z.boolean(),
}).superRefine((fields, context) => {
  if (fields.min_participants !== null && fields.max_participants !== null && fields.min_participants > fields.max_participants) {
    context.addIssue({ code: "custom", path: ["max_participants"], message: "Maximum must be at least the minimum." });
  }
});

const coachingCurrencySchema = z.enum(locationCurrencies, "Select a supported currency.");

// Club-default prices saved with the program, per currency and selected duration. Omitted
// prices are unchanged; an empty amount is never sent, and removal is always explicit.
const clubPriceKey = { currency: coachingCurrencySchema, duration_minutes: z.number().int() };
const clubPriceKeyText = (price: { currency: string; duration_minutes: number }) => `${price.currency}:${price.duration_minutes}`;
export const coachingProgramMutationSchema = z.strictObject({
  id: z.uuid().optional(), fields: coachingProgramFieldsSchema,
  club_prices: z.array(z.strictObject({ ...clubPriceKey, amount: majorAmountSchema })).max(400).optional(),
  removed_club_prices: z.array(z.strictObject(clubPriceKey)).max(400).optional(),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  value.club_prices?.forEach((price, index) => {
    const key = clubPriceKeyText(price);
    if (!value.fields.durations.includes(price.duration_minutes)) {
      context.addIssue({ code: "custom", path: ["club_prices", index, "amount"], message: "Select this duration before setting its price." });
    } else if (seen.has(key)) {
      context.addIssue({ code: "custom", path: ["club_prices", index, "amount"], message: "Enter each price once." });
    }
    seen.add(key);
  });
  value.removed_club_prices?.forEach((price, index) => {
    if (!value.id) context.addIssue({ code: "custom", path: ["removed_club_prices", index], message: "A new program has no prices to remove." });
    else if (seen.has(clubPriceKeyText(price))) context.addIssue({ code: "custom", path: ["removed_club_prices", index], message: "A price cannot be both saved and removed." });
  });
});
export const coachingProgramStatusSchema = z.strictObject({ id: z.uuid(), is_active: z.boolean() });

const textList = (label: string) => z.array(z.string().trim().min(1).max(60, `Each ${label} must use at most 60 characters.`))
  .max(12, `Use at most 12 ${label}s.`);

export const coachProfileFieldsSchema = z.strictObject({
  display_name: z.string().trim().min(1, "Enter the public name.").max(100, "Use at most 100 characters."),
  bio: z.string().trim().max(2000, "Use at most 2,000 characters."),
  qualifications: z.string().trim().max(1000, "Use at most 1,000 characters."),
  specialties: textList("specialty"),
  languages: textList("language"),
  location_ids: z.array(z.uuid()).max(50).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "Select each location once."),
  program_ids: z.array(z.uuid()).max(100).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "Select each program once."),
  is_public: z.boolean(),
});

// Creation names the coach account; edits address the existing profile.
export const coachProfileMutationSchema = z.strictObject({
  user_id: z.uuid("Select a coach account."), create: z.boolean(), fields: coachProfileFieldsSchema,
});
export const coachVisibilitySchema = z.strictObject({ user_id: z.uuid(), is_public: z.boolean() });

// One price for a program duration in a currency. The input never names a coach:
// Admin operations set the club default, Coach operations the signed-in coach's override.
export const coachingPriceMutationSchema = z.strictObject({
  program_id: z.uuid(), duration_minutes: coachingDurationSchema,
  currency: coachingCurrencySchema, amount: majorAmountSchema,
});
// Legacy configuration can still be removed without allowing new unsupported prices.
export const coachingPriceRemovalSchema = coachingPriceMutationSchema.omit({ amount: true }).extend({
  duration_minutes: z.number().int().min(15).max(480),
});

export type CoachingMutationResult =
  | { ok: true; id: string; archived?: boolean }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "has-bookings" | "active-lessons" | "not-found" | "has-prices" | "has-availability" | "not-eligible" | "already-exists" | "invalid-location" | "invalid-program" | "not-offered" };

export function coachingFieldErrors(issues: readonly z.core.$ZodIssue[]) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    // Program club prices are reported per submitted entry, e.g. "club_prices.2".
    if ((issue.path[0] === "club_prices" || issue.path[0] === "removed_club_prices") && typeof issue.path[1] === "number") {
      fieldErrors[`${issue.path[0]}.${issue.path[1]}`] ??= issue.message;
      continue;
    }
    const field = issue.path.find((part) => typeof part === "string" && part !== "fields");
    fieldErrors[String(field ?? "form")] ??= issue.message;
  }
  return fieldErrors;
}
