import { Pagination } from "@/components/pagination";
import { listAdminUndeliveredNotifications } from "@/lib/notifications/admin-notifications";
import { adminNotificationHref, notificationTimezone } from "@/lib/notifications/admin-notification-query";
import { NotificationsTable } from "../notifications-table";
import { NotificationsToolbar } from "../notifications-toolbar";

export const instant = false;

export default async function AdminNotificationsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await listAdminUndeliveredNotifications(await searchParams);
  const { query } = result;
  const filtered = Boolean(query.q || query.status !== "all" || query.type !== "all" || query.from || query.to);
  return <>
    <h2 className="mb-1 font-heading text-xl font-semibold text-primary">Undelivered notifications</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Emails that could not be delivered. Retry sending or delete the notification after handling it manually.
    </p>
    <NotificationsToolbar query={query} />
    <p className="mb-2 text-sm text-muted-foreground">{result.total} {filtered ? "matching" : "undelivered"}
      {result.unacknowledgedExceptions > 0 && <> · <span className="font-semibold text-danger">{result.unacknowledgedExceptions} financial
        {result.unacknowledgedExceptions === 1 ? " exception" : " exceptions"}</span></>}</p>
    <p className="mb-2 text-xs text-muted-foreground">Times in {notificationTimezone}.</p>
    {result.rows.length ? <NotificationsTable key={adminNotificationHref(query)} rows={result.rows} query={query} />
      : <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted-foreground">
        {filtered ? "No notifications match these filters." : "No booking email needs attention."}</p>}
    {result.totalPages > 1 && <div className="mt-6"><Pagination currentPage={result.page} totalPages={result.totalPages}
      buildHref={(page) => adminNotificationHref(query, page)} /></div>}
  </>;
}
