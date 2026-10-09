import { z } from "zod";
import { timeToMinute } from "@/lib/admin/opening-hours-validation";
import { majorAmountSchema, minorAmountSchema } from "./money";

export const courtStates = ["outdoor", "covered", "indoor"] as const;
export const courtStateLabels = {
  outdoor: "Outdoor",
  covered: "Covered",
  indoor: "Indoor",
} as const;
const timeSchema = z
  .string()
  .regex(
    /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/,
    "Enter a time as HH:mm (00:00–24:00).",
  );
const optionalDateSchema = z
  .union([z.iso.date(), z.literal("")])
  .transform((value) => value || null);

export const pricingRuleSchema = z
  .object({
    id: z.uuid(),
    rule_set_id: z.uuid(),
    location_id: z.uuid(),
    court_id: z.uuid(),
    court_state: z.enum(courtStates),
    weekday: z.number().int().min(0).max(6),
    starts_at_minute: z.number().int().min(0).max(1439),
    ends_at_minute: z.number().int().min(1).max(1440),
    starts_on: z.iso.date().nullable(),
    ends_on: z.iso.date().nullable(),
    price_per_hour_minor: minorAmountSchema,
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .refine((value) => value.starts_at_minute < value.ends_at_minute)
  .refine(
    (value) =>
      !value.starts_on || !value.ends_on || value.starts_on <= value.ends_on,
  );
export type PricingRule = z.infer<typeof pricingRuleSchema>;
export type PricingRuleSet = Omit<
  PricingRule,
  "id" | "court_id" | "weekday"
> & { court_ids: string[]; weekdays: number[] };

export const pricingDefinitionSchema = z
  .strictObject({
    location_id: z.uuid(),
    court_state: z.enum(courtStates),
    court_ids: z
      .array(z.uuid())
      .min(1, "Select at least one court.")
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each court only once.",
      ),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Select at least one weekday.")
      .max(7)
      .refine(
        (days) => new Set(days).size === days.length,
        "Select each weekday only once.",
      ),
    starts_at: timeSchema.refine(
      (value) => value !== "24:00",
      "Start time must be before 24:00.",
    ),
    ends_at: timeSchema,
    starts_on: optionalDateSchema,
    ends_on: optionalDateSchema,
    price_per_hour: majorAmountSchema,
  })
  .refine(
    (value) =>
      !timeSchema.safeParse(value.starts_at).success ||
      !timeSchema.safeParse(value.ends_at).success ||
      timeToMinute(value.starts_at) < timeToMinute(value.ends_at),
    { path: ["ends_at"], message: "End time must be after start time." },
  )
  .refine(
    (value) =>
      !value.starts_on || !value.ends_on || value.starts_on <= value.ends_on,
    {
      path: ["ends_on"],
      message: "Valid-until date must be on or after valid-from date.",
    },
  );
export const pricingMutationSchema = pricingDefinitionSchema.safeExtend({
  rule_set_id: z.uuid().optional(),
});
export const pricingRemovalSchema = z.strictObject({
  rule_set_id: z.uuid(),
  location_id: z.uuid(),
});
export type PricingMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap" | "not-found" };

export type PricingOverlapRule = {
  courtId: string; courtState: string; weekday: number;
  startsAtMinute: number; endsAtMinute: number;
  startsOn: string | null; endsOn: string | null;
};

export function pricingRulesOverlap(a: PricingOverlapRule, b: PricingOverlapRule): boolean {
  return a.courtId.toLowerCase() === b.courtId.toLowerCase()
    && a.courtState === b.courtState && a.weekday === b.weekday
    && a.startsAtMinute < b.endsAtMinute && b.startsAtMinute < a.endsAtMinute
    && (a.startsOn === null || b.endsOn === null || a.startsOn <= b.endsOn)
    && (b.startsOn === null || a.endsOn === null || b.startsOn <= a.endsOn);
}
