"use client";

import Link from "next/link";

import { FilterClearSlot } from "@/components/filter-clear-slot";
import { FilterPendingIndicator } from "@/components/navigation-pending";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { inboxCategories, inboxHref, inboxSearch, inboxSorts, inboxStatuses, parseInboxQuery, type InboxQuery } from "@/lib/notifications/inbox-query";

const statusLabels = { all: "All", unread: "Unread", read: "Read" } as const;
const categoryLabels = { all: "All categories", bookings: "Bookings", coaching: "Coaching", payments: "Payments", club: "Club" } as const;
const sortLabels = { newest: "Newest first", oldest: "Oldest first", subject_asc: "Subject A–Z", subject_desc: "Subject Z–A" } as const;

export function InboxFilters({ query }: { query: InboxQuery }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const queryString = inboxSearch(query);
  const [draft, setDraft] = useState({ source: queryString, text: query.q, submitted: query.q });
  // Keep newer typing when an earlier search response arrives; sync settled URL navigation.
  if (draft.source !== queryString) {
    setDraft({ source: queryString, text: draft.text === draft.submitted ? query.q : draft.text,
      submitted: query.q });
  }
  const text = draft.source !== queryString && draft.text === draft.submitted ? query.q : draft.text;
  const hasFilters = Boolean(query.q || query.status !== "all" || query.category !== "all" || query.sort !== "newest");
  const currentQuery = useRef(queryString);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function cancelSearch() { clearTimeout(timer.current); timer.current = undefined; }
  useEffect(() => { currentQuery.current = queryString; }, [queryString]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(key: "q" | "status" | "category" | "sort", value: string) {
    if (key === "q") cancelSearch();
    const params = new URLSearchParams(currentQuery.current);
    params.set(key, value);
    const next = parseInboxQuery(Object.fromEntries(params));
    if (key !== "sort") next.page = 1;
    const nextQuery = inboxSearch(next);
    if (key === "q") setDraft((current) => ({ ...current, text: value, submitted: next.q }));
    if (nextQuery === currentQuery.current) return;
    currentQuery.current = nextQuery;
    startTransition(() => router.replace(inboxHref(next), { scroll: false }));
  }

  return (
    <form role="search" onSubmit={(event) => { event.preventDefault(); navigate("q", text.trim()); }}
      className="relative mb-4 flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface-elevated p-3 shadow-card">
      <label className="min-w-48 flex-[2_1_16rem] text-xs font-semibold text-muted-foreground">Search notifications
        <input type="search" name="q" value={text} onChange={(event) => {
          const next = event.target.value;
          setDraft({ source: queryString, text: next, submitted: draft.submitted });
          cancelSearch();
          timer.current = setTimeout(() => navigate("q", next.trim()), 300);
        }} maxLength={200} placeholder="Search subject or message"
          className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary" />
      </label>
      <label className="min-w-28 flex-1 text-xs font-semibold text-muted-foreground">Status
        <select name="status" value={query.status} onChange={(event) => navigate("status", event.target.value)} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}
        </select>
      </label>
      <label className="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">Category
        <select name="category" value={query.category} onChange={(event) => navigate("category", event.target.value)} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxCategories.map(value => <option key={value} value={value}>{categoryLabels[value]}</option>)}
        </select>
      </label>
      <label className="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">Sort
        <select name="sort" value={query.sort} onChange={(event) => navigate("sort", event.target.value)} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxSorts.map(value => <option key={value} value={value}>{sortLabels[value]}</option>)}
        </select>
      </label>
      <FilterClearSlot active={hasFilters}>
        <Link scroll={false} href="/messages" onNavigate={event => { event.preventDefault(); currentQuery.current = ""; startTransition(() => router.replace("/messages", { scroll: false })); }} className="inline-flex min-h-10 items-center px-2 text-sm font-semibold text-primary underline"
          onClick={() => { cancelSearch(); setDraft({ source: queryString, text: "", submitted: "" }); }}>Clear</Link>
      </FilterClearSlot>
      <FilterPendingIndicator pending={pending} />
    </form>
  );
}
