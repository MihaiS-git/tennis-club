import { z } from "zod";

export const inboxStatuses = ["all", "unread", "read"] as const;
export const inboxCategories = ["all", "bookings", "coaching", "payments", "club"] as const;
export const inboxSorts = ["newest", "oldest", "subject_asc", "subject_desc"] as const;

export type InboxQuery = {
  q: string; status: typeof inboxStatuses[number]; category: typeof inboxCategories[number];
  sort: typeof inboxSorts[number]; page: number;
};

export function inboxPage(raw: unknown) {
  const parsed = z.coerce.number().int().min(1).max(100000).safeParse(raw ?? "1");
  return parsed.success ? parsed.data : 1;
}

export function parseInboxQuery(raw: Record<string, string | string[] | undefined>): InboxQuery {
  const text = typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "";
  return {
    q: text,
    status: z.enum(inboxStatuses).catch("all").parse(raw.status),
    category: z.enum(inboxCategories).catch("all").parse(raw.category),
    sort: z.enum(inboxSorts).catch("newest").parse(raw.sort),
    page: inboxPage(raw.page),
  };
}

export function inboxSearch(query: InboxQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status !== "all") params.set("status", query.status);
  if (query.category !== "all") params.set("category", query.category);
  if (query.sort !== "newest") params.set("sort", query.sort);
  params.set("page", String(query.page));
  return params.toString();
}

export function inboxHref(query: InboxQuery) {
  return `/messages?${inboxSearch(query)}`;
}
