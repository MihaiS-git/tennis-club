import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logger } from "@/lib/logger";
import { listOwnMessages, messageAccess, messageCategory, messagesPerPage } from "@/lib/notifications/inbox";
import { inboxCategories, inboxHref, inboxSearch, inboxSorts, inboxStatuses, parseInboxQuery } from "@/lib/notifications/inbox-query";
import { InboxList } from "./inbox-list";

export const metadata: Metadata = { title: "Notifications | Tennis Club" };

const statusLabels = { all: "All", unread: "Unread", read: "Read" } as const;
const categoryLabels = { all: "All categories", bookings: "Bookings", coaching: "Coaching", payments: "Payments", club: "Club" } as const;
const sortLabels = { newest: "Newest first", oldest: "Oldest first", subject_asc: "Subject A–Z", subject_desc: "Subject Z–A" } as const;

export default async function MessagesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await messageAccess();
  if (access.state === "unauthenticated") redirect("/login");
  if (access.state !== "ready") return <p role="alert" className="text-sm text-muted-foreground">Your notifications are unavailable right now.</p>;
  const query = parseInboxQuery(await searchParams);
  let inbox;
  try { inbox = await listOwnMessages(access.userId, query); }
  catch {
    logger.error({ event: "messages.inbox_failed" }, "Failed to load notifications");
    return <p role="alert" className="rounded-card border border-border bg-surface p-5 text-sm text-primary">Unable to load notifications. Please try again.</p>;
  }
  return <section aria-labelledby="messages-heading" className="min-w-0">
    <h1 id="messages-heading" className="font-heading text-3xl font-semibold text-primary">Notifications</h1>
    <p className="mt-2 mb-6 text-sm text-muted-foreground">Updates about your bookings and payments.</p>
    <form action="/messages" method="get" role="search"
      className="mb-4 flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface-elevated p-3 shadow-card">
      <label className="min-w-48 flex-[2_1_16rem] text-xs font-semibold text-muted-foreground">Search notifications
        <input type="search" name="q" defaultValue={query.q} maxLength={200} placeholder="Search subject or message"
          className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary" />
      </label>
      <label className="min-w-28 flex-1 text-xs font-semibold text-muted-foreground">Status
        <select name="status" defaultValue={query.status} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}
        </select>
      </label>
      <label className="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">Category
        <select name="category" defaultValue={query.category} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxCategories.map(value => <option key={value} value={value}>{categoryLabels[value]}</option>)}
        </select>
      </label>
      <label className="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">Sort
        <select name="sort" defaultValue={query.sort} className="mt-1 min-h-10 w-full rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground">
          {inboxSorts.map(value => <option key={value} value={value}>{sortLabels[value]}</option>)}
        </select>
      </label>
      <button type="submit" className="min-h-10 rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Apply</button>
      {(query.q || query.status !== "all" || query.category !== "all" || query.sort !== "newest") &&
        <Link href="/messages" className="inline-flex min-h-10 items-center px-2 text-sm font-semibold text-primary underline">Clear</Link>}
    </form>
    <div className="overflow-hidden rounded-card border border-border bg-surface-elevated shadow-card">
      {inbox.total === 0 ? <p className="p-6 text-sm text-muted-foreground">{query.q || query.status !== "all" || query.category !== "all"
        ? "No notifications match your search or filters." : "You have no notifications yet."}</p>
        : inbox.messages.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No notifications on this page.</p>
          : <InboxList key={inboxSearch(query)} query={query} search={inboxSearch(query)} rows={inbox.messages.map(message => ({
            id: message.id, category: messageCategory(message.kind), subject: message.subject, bodyText: message.bodyText,
            read: message.readAt !== null, createdAt: message.createdAt.toISOString(),
            createdLabel: message.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
          }))} />}
    </div>
    {inbox.total > 0 && <nav aria-label="Notifications pages" className="mt-5 flex items-center justify-between gap-3 text-sm">
      <div>{inbox.hasPrevious ? <Link className="font-semibold text-primary hover:text-accent" href={inboxHref({ ...query, page: query.page - 1 })}>Previous</Link> : <span className="text-muted-foreground">Previous</span>}</div>
      <span className="text-muted-foreground">Page {query.page} of {Math.max(1, Math.ceil(inbox.total / messagesPerPage))}</span>
      <div>{inbox.hasNext ? <Link className="font-semibold text-primary hover:text-accent" href={inboxHref({ ...query, page: query.page + 1 })}>Next</Link> : <span className="text-muted-foreground">Next</span>}</div>
    </nav>}
  </section>;
}
