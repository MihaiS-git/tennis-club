import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { adminUserFiltersSchema } from "@/lib/admin/users-filters";

const common = adminUserFiltersSchema.pick({ search: true, page: true, dir: true }).extend({
  dir: z.enum(["asc", "desc"]).catch("asc").default("asc"),
});
export const programFiltersSchema = common.extend({
  type: z.enum(["private", "semi_private", "group", "junior"]).optional().catch(undefined),
  status: z.enum(["active", "inactive"]).optional().catch(undefined),
  sort: z.enum(["name", "type", "status"]).catch("name").default("name"),
});
export const priceFiltersSchema = common.extend({
  currency: z.enum(locationCurrencies).optional().catch(undefined),
  program: z.uuid().transform(value => value.toLowerCase()).optional().catch(undefined),
  coach: z.uuid().transform(value => value.toLowerCase()).optional().catch(undefined),
  duration: z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().positive().max(1440).optional().catch(undefined)),
  scope: z.enum(["club", "coach"]).optional().catch(undefined),
  sort: z.enum(["program", "currency", "duration", "amount"]).catch("program").default("program"),
}).transform(filters => ({ ...filters, coach: filters.scope === "club" ? undefined : filters.coach }));
export const coachFiltersSchema = common.extend({
  status: z.enum(["active", "suspended"]).optional().catch(undefined),
  profile: z.enum(["configured", "not-configured", "archived"]).optional().catch(undefined),
  visibility: z.enum(["public", "private"]).optional().catch(undefined),
  sort: z.enum(["name", "email", "status", "profile", "created"]).catch("name").default("name"),
});
export type CoachFilters = z.output<typeof coachFiltersSchema>;
export type ProgramFilters = z.output<typeof programFiltersSchema>;
export type PriceFilters = z.output<typeof priceFiltersSchema>;

export function coachingListHref(path: string, filters: ProgramFilters | PriceFilters | CoachFilters, change: Record<string, string | number> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...change })) {
    if (value !== undefined && value !== "") query.set(key === "search" ? "q" : key, String(value));
  }
  return `${path}?${query}`;
}
