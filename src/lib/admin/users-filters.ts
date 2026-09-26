import { z } from "zod";

export const adminUserFiltersSchema = z.object({
  search: z.preprocess(
    (value) => typeof value === "string" ? value.trim() || undefined : undefined,
    z.string().optional(),
  ),
  status: z.enum(["active", "suspended"]).optional().catch(undefined),
  role: z.enum(["admin", "coach"]).optional().catch(undefined),
  sort: z.enum(["email", "status", "roles", "joined"]).catch("joined").default("joined"),
  dir: z.enum(["asc", "desc"]).catch("desc").default("desc"),
  page: z.preprocess(
    (value) => typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value,
    z.number().int().positive().safe().catch(1).default(1),
  ),
});

export type AdminUserFilters = z.output<typeof adminUserFiltersSchema>;
export type AdminUserListInput = {
  search?: string;
  status?: "active" | "suspended";
  role?: "admin" | "coach";
  page?: number;
  sort?: AdminUserFilters["sort"];
  dir?: AdminUserFilters["dir"];
};
