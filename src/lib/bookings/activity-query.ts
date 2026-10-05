import { z } from "zod";

export type ActivitySearchParams = Record<string, string | string[] | undefined>;
export type ActivityScope = "upcoming" | "history";
export const ACTIVITY_PAGE_SIZE = 20;

const fields = {
  type: z.enum(["all", "booking", "reservation"]).catch("all"),
  status: z.enum(["all", "completed", "cancelled"]).catch("all"),
  location: z.uuid().catch("").transform((value) => value || undefined),
  court: z.uuid().catch("").transform((value) => value || undefined),
  from: z.iso.date().catch("").transform((value) => value || undefined),
  to: z.iso.date().catch("").transform((value) => value || undefined),
  sort: z.enum(["datetime", "location", "court", "type", "duration", "status"]).catch("datetime"),
};

export function parseActivityQuery(params: ActivitySearchParams, scope: ActivityScope, staff = true) {
  const filters = z.object(fields).parse(params);
  if (!staff) filters.type = "booking";
  if (scope === "upcoming") {
    filters.status = "all";
    if (filters.sort === "status") filters.sort = "datetime";
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    filters.from = undefined;
    filters.to = undefined;
  }
  const value = params.page;
  const page = typeof value === "string" && /^[1-9]\d*$/.test(value) && Number(value) <= 1000000 ? Number(value) : 1;
  const direction = z.enum(["asc", "desc"]).catch(scope === "history" ? "desc" : "asc").parse(params.direction);
  return { ...filters, page, direction };
}
export type ActivityQuery = ReturnType<typeof parseActivityQuery>;

export function activityHref(scope: ActivityScope, query: ActivityQuery, page = query.page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, page: String(page) })) {
    if (value !== undefined) params.set(key, String(value));
  }
  return `/my-activity/${scope === "upcoming" ? "bookings" : "history"}?${params}`;
}
