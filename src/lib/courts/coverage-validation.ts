import { z } from "zod";

export const coverageDatesSchema = z.strictObject({
  starts_on: z.iso.date("Enter a valid start date."),
  ends_on: z.iso.date("Enter a valid end date."),
}).refine((dates) => dates.starts_on <= dates.ends_on, {
  path: ["ends_on"], message: "End date must be on or after start date.",
});
export type CoverageDates = z.infer<typeof coverageDatesSchema>;
export const coveragePeriodSchema = coverageDatesSchema.safeExtend({
  id: z.uuid(), court_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
});
export type CoveragePeriod = z.infer<typeof coveragePeriodSchema>;
export const coverageMutationSchema = z.strictObject({
  id: z.uuid().optional(), court_id: z.uuid(), dates: coverageDatesSchema,
});
export const coverageRemovalSchema = z.strictObject({ id: z.uuid(), court_id: z.uuid() });
export type CoverageMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "overlap" | "outdoor-only" | "not-found" };
