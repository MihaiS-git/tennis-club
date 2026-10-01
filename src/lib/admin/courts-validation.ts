import { z } from "zod";

export const courtSurfaces = ["clay", "hard", "grass", "carpet"] as const;
export const courtEnvironments = ["outdoor", "indoor"] as const;
export const courtSurfaceLabels: Record<typeof courtSurfaces[number], string> = {
  clay: "Clay", hard: "Hard", grass: "Grass", carpet: "Carpet",
};
export const courtEnvironmentLabels: Record<typeof courtEnvironments[number], string> = {
  outdoor: "Outdoor", indoor: "Indoor",
};

export function generateCourtSlug(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const courtFieldsSchema = z.strictObject({
  location_id: z.uuid("Select a location."),
  name: z.string().trim().min(1, "Enter a court name.").max(100, "Use at most 100 characters."),
  surface: z.enum(courtSurfaces, "Select a supported surface."),
  environment: z.enum(courtEnvironments, "Select indoor or outdoor."),
  has_lighting: z.boolean(),
  is_active: z.boolean(),
});
export const courtMutationSchema = z.strictObject({
  id: z.uuid().optional(),
  fields: courtFieldsSchema,
});
export type CourtMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "duplicate-slug" | "not-found" | "invalid-location" | "has-coverage" | "has-pricing" };
