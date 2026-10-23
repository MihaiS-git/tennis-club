import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logger } from "@/lib/logger";
import { listOwnMessages, messageAccess, messageCategory, messagesPerPage } from "@/lib/notifications/inbox";
import { inboxHref, inboxSearch, parseInboxQuery } from "@/lib/notifications/inbox-query";
import { InboxFilters } from "./inbox-filters";
import { InboxList } from "./inbox-list";

export const metadata: Metadata = { title: "Notifications | Tennis Club" };

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
    <InboxFilters query={query} />
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
