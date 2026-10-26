import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { majorAmountSchema } from "@/lib/pricing/money";

export const coachingProgramTypes = ["private", "semi_private", "group", "junior"] as const;
export type CoachingProgramType = typeof coachingProgramTypes[number];
export const coachingProgramTypeLabels: Record<CoachingProgramType, string> = {
  private: "Private", semi_private: "Semi-private", group: "Group", junior: "Junior",
};

// Private and Semi-private lessons are booked online with optional Coach overrides.
// Group and Junior sessions are organized by the club and retain Club-only prices.
export type OnlineCoachingProgramType = "private" | "semi_private";
export function isOnlineCoachingProgramType(type: CoachingProgramType): type is OnlineCoachingProgramType {
  return type === "private" || type === "semi_private";
}
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

// The configurable participant bounds; a lesson books one count within its program's range.
const maxProgramParticipants = 100;
const optionalCount = z.union([z.null(), z.number().int().min(1, "Use at least 1.").max(maxProgramParticipants, "Use at most 100.")]);
export const participantCountSchema = z.number().int().min(1).max(maxProgramParticipants);

// The participant counts one lesson of the program may be booked for: its explicitly
// configured limits, 1 ≤ min ≤ max ≤ 100. Null (not bookable online) when either is
// missing or invalid; nothing is inferred from the program type or filled in.
export function coachingParticipantRange(program: { minParticipants: number | null; maxParticipants: number | null }) {
  const { minParticipants: min, maxParticipants: max } = program;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min! < 1 || min! > max! || max! > maxProgramParticipants) return null;
  return { min: min!, max: max! };
}
export function isPermittedParticipantCount(range: { min: number; max: number }, count: number) {
  return Number.isInteger(count) && range.min <= count && count <= range.max;
}
// Every permitted count, each of which has its own independently configured price.
export function coachingParticipantCounts(range: { min: number; max: number } | null) {
  return range ? Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index) : [];
}
export function formatPlayers(count: number) {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

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
  // Active programs are bookable online, which requires both limits.
  if (fields.is_active && fields.min_participants === null) {
    context.addIssue({ code: "custom", path: ["min_participants"], message: "Enter the minimum players for an active program." });
  }
  if (fields.is_active && fields.max_participants === null) {
    context.addIssue({ code: "custom", path: ["max_participants"], message: "Enter the maximum players for an active program." });
  }
  if (fields.min_participants !== null && fields.max_participants !== null && fields.min_participants > fields.max_participants) {
    context.addIssue({ code: "custom", path: ["max_participants"], message: "Maximum must be at least the minimum." });
  }
});

const coachingCurrencySchema = z.enum(locationCurrencies, "Select a supported currency.");

// Club lesson prices/person saved with the program, per currency, selected duration and
// participant count. Omitted prices are unchanged; an empty amount is never sent, and removal is
// always explicit. Prices made obsolete by the saved program are removed by the service.
const clubPriceKey = { currency: coachingCurrencySchema, duration_minutes: coachingDurationSchema, participant_count: participantCountSchema };
const clubPriceKeyText = (price: { currency: string; duration_minutes: number; participant_count: number }) =>
  `${price.currency}:${price.duration_minutes}:${price.participant_count}`;
export const coachingProgramMutationSchema = z.strictObject({
  id: z.uuid().optional(), fields: coachingProgramFieldsSchema,
  club_prices: z.array(z.strictObject({ ...clubPriceKey, amount: majorAmountSchema })).max(1000).optional(),
  removed_club_prices: z.array(z.strictObject(clubPriceKey)).max(1000).optional(),
}).superRefine((value, context) => {
  const seen = new Set<string>();
  const range = coachingParticipantRange({ minParticipants: value.fields.min_participants, maxParticipants: value.fields.max_participants });
  value.club_prices?.forEach((price, index) => {
    const key = clubPriceKeyText(price);
    const issue = (message: string) => context.addIssue({ code: "custom", path: ["club_prices", index, "amount"], message });
    if (!value.fields.durations.includes(price.duration_minutes)) issue("Select this duration before setting its price.");
    else if (!range) issue("Set the minimum and maximum players before setting prices.");
    else if (!isPermittedParticipantCount(range, price.participant_count)) issue(`Use a player count from ${range.min} to ${range.max}.`);
    else if (seen.has(key)) issue("Enter each price once.");
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

// One coach's own lesson price/person for a program duration and participant count in a currency.
// The input never names a coach: the owner is the signed-in coach.
export const coachingPriceMutationSchema = z.strictObject({
  program_id: z.uuid(), duration_minutes: coachingDurationSchema, participant_count: participantCountSchema,
  currency: coachingCurrencySchema, amount: majorAmountSchema,
});
export const coachingPriceRemovalSchema = coachingPriceMutationSchema.omit({ amount: true });

// Club lesson prices/person of one program duration in one currency, by participant count.
// Omitted counts are unchanged; an empty amount is never sent and removal is explicit.
export const clubPriceSetMutationSchema = z.strictObject({
  program_id: z.uuid(), currency: coachingCurrencySchema, duration_minutes: coachingDurationSchema,
  prices: z.array(z.strictObject({ participant_count: participantCountSchema, amount: majorAmountSchema })).max(100),
  removed: z.array(participantCountSchema).max(100),
}).superRefine((value, context) => {
  const saved = new Set<number>();
  value.prices.forEach((price, index) => {
    if (saved.has(price.participant_count)) context.addIssue({ code: "custom", path: ["prices", index, "amount"], message: "Enter each player count once." });
    saved.add(price.participant_count);
  });
  value.removed.forEach((count, index) => {
    if (saved.has(count)) context.addIssue({ code: "custom", path: ["removed", index], message: "A price cannot be both saved and removed." });
  });
  if (new Set(value.removed).size !== value.removed.length) context.addIssue({ code: "custom", path: ["removed"], message: "Remove each player count once." });
  if (!value.prices.length && !value.removed.length) context.addIssue({ code: "custom", path: ["form"], message: "There are no changes to save." });
});

export type CoachingMutationResult =
  | { ok: true; id: string; archived?: boolean }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "has-bookings" | "active-lessons" | "not-found" | "has-prices" | "has-availability" | "not-eligible" | "already-exists" | "invalid-location" | "invalid-program" | "not-offered" | "participants-required" | "club-priced" | "invalid-currency" };

export function coachingFieldErrors(issues: readonly z.core.$ZodIssue[]) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    // Submitted price entries are reported per entry, e.g. "club_prices.2" or "prices.0".
    if (["club_prices", "removed_club_prices", "prices", "removed"].includes(String(issue.path[0])) && typeof issue.path[1] === "number") {
      fieldErrors[`${String(issue.path[0])}.${issue.path[1]}`] ??= issue.message;
      continue;
    }
    const field = issue.path.find((part) => typeof part === "string" && part !== "fields");
    fieldErrors[String(field ?? "form")] ??= issue.message;
  }
  return fieldErrors;
}
