import { z } from "zod";
import type { AdminCourt } from "@/lib/admin/courts";
import { courtEnvironments, courtSurfaces, courtEnvironmentLabels, courtSurfaceLabels } from "@/lib/admin/courts-validation";

export const courtInventorySchema = z.object({
  status: z.enum(["active", "inactive"]).optional().catch(undefined),
  surface: z.enum(courtSurfaces).optional().catch(undefined),
  environment: z.enum(courtEnvironments).optional().catch(undefined),
  sort: z.enum(["name", "status", "surface", "environment", "lighting"]).catch("name").default("name"),
  dir: z.enum(["asc", "desc"]).catch("asc").default("asc"),
});

export type CourtInventoryOptions = z.output<typeof courtInventorySchema>;

const nameCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareNames(left: AdminCourt, right: AdminCourt) {
  return nameCollator.compare(left.name, right.name) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function selectLocationCourts(courts: AdminCourt[], locationId: string, options: CourtInventoryOptions) {
  return courts.filter((court) => court.location_id === locationId
    && (!options.status || court.is_active === (options.status === "active"))
    && (!options.surface || court.surface === options.surface)
    && (!options.environment || court.environment === options.environment))
    .sort((left, right) => {
      const primary = options.sort === "name" ? compareNames(left, right)
        : options.sort === "status" ? Number(left.is_active) - Number(right.is_active)
        : options.sort === "surface" ? courtSurfaceLabels[left.surface].localeCompare(courtSurfaceLabels[right.surface])
        : options.sort === "environment" ? courtEnvironmentLabels[left.environment].localeCompare(courtEnvironmentLabels[right.environment])
        : Number(left.has_lighting) - Number(right.has_lighting);
      return (options.dir === "asc" ? primary : -primary) || compareNames(left, right);
    });
}
