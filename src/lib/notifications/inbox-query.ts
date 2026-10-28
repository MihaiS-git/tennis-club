export const inboxStatuses = ["all", "unread", "read"] as const;
export const inboxCategories = ["all", "bookings", "coaching", "payments", "club"] as const;
export const inboxSorts = ["newest", "oldest", "subject_asc", "subject_desc"] as const;

export type InboxQuery = {
  q: string; status: typeof inboxStatuses[number]; category: typeof inboxCategories[number];
  sort: typeof inboxSorts[number]; page: number;
};

// Plain checks instead of Zod: the inbox filters parse the URL in the browser.
// Like a coerced number, a single-item array (repeated parameter) converts to
// its value, while several values, blanks and non-integers fall back to 1.
export function inboxPage(raw: unknown) {
  const page = Number(raw ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}

// An exact match from the allowed values, otherwise the default.
function inboxOption<const T extends readonly string[]>(values: T, raw: unknown, fallback: T[number]): T[number] {
  return values.find((value) => value === raw) ?? fallback;
}

export function parseInboxQuery(raw: Record<string, string | string[] | undefined>): InboxQuery {
  const text = typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "";
  return {
    q: text,
    status: inboxOption(inboxStatuses, raw.status, "all"),
    category: inboxOption(inboxCategories, raw.category, "all"),
    sort: inboxOption(inboxSorts, raw.sort, "newest"),
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
