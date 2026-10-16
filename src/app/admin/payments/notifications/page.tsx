import { Pagination } from "@/components/pagination";
import { listAdminUndeliveredNotifications } from "@/lib/notifications/admin-notifications";
import { NotificationRetryButton } from "../notification-retry-button";

export const instant = false;

const statusLabels: Record<string, string> = {
  rejected: "Rejected by Brevo",
  unavailable: "Brevo temporarily unavailable",
  unconfirmed: "No response from Brevo (may have been sent)",
  not_configured: "Email is not configured",
};
const utc = (value: string) => new Date(value).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
const pageHref = (page: number) => page > 1 ? `/admin/payments/notifications?page=${page}` : "/admin/payments/notifications";

export default async function AdminNotificationsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { page } = await searchParams;
  const result = await listAdminUndeliveredNotifications({ page: Array.isArray(page) ? page[0] : page });
  return <>
    <h2 className="mb-2 font-heading text-xl font-semibold text-primary">Undelivered notifications</h2>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
      Booking emails Brevo has not accepted. Temporary failures are retried automatically every few minutes with
      increasing delays; a permanent rejection or a message that keeps failing stops retrying and waits for you here.
      Unacknowledged financial exceptions are listed first. Important financial notices are also shown to signed-in
      customers in My activity. Times in UTC.
    </p>
    {result.total > 0 && <p className="mb-3 text-sm text-muted-foreground">{result.total} undelivered
      {result.unacknowledgedExceptions > 0 && <> · <span className="font-semibold text-danger">{result.unacknowledgedExceptions} financial
        {result.unacknowledgedExceptions === 1 ? " exception" : " exceptions"}</span></>}</p>}
    {result.rows.length ? <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table aria-label="Undelivered notifications" className="w-full text-left text-sm">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>{["Created", "Recipient", "Subject", "Booking", "Status", "Attempts", "Next retry", ""].map(label =>
            <th key={label} scope="col" className="px-3 py-3">{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-border">{result.rows.map(row => <tr key={row.id} className="[&_td]:px-3 [&_td]:py-3">
          <td className="whitespace-nowrap"><time dateTime={row.created_at}>{utc(row.created_at)}</time></td>
          <td className="break-all">{row.recipient}</td>
          <td>{row.subject}{row.important && <span className="block text-xs font-semibold text-danger">Financial exception</span>}</td>
          <td className="break-all font-mono text-xs">{row.booking_id ?? "—"}</td>
          <td>{row.last_error ? statusLabels[row.last_error] ?? "Not delivered" : "Not attempted yet"}</td>
          <td className="tabular-nums">{row.attempts}</td>
          <td className="whitespace-nowrap">{row.next_attempt_at ? <time dateTime={row.next_attempt_at}>{utc(row.next_attempt_at)}</time>
            : <span className="font-semibold text-danger">Stopped; retry manually</span>}</td>
          <td><NotificationRetryButton id={row.id} /></td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="rounded-card border border-border bg-surface p-6 text-muted-foreground">All booking emails have been accepted by Brevo.</p>}
    {result.totalPages > 1 && <div className="mt-6"><Pagination currentPage={result.page} totalPages={result.totalPages} buildHref={pageHref} /></div>}
  </>;
}
