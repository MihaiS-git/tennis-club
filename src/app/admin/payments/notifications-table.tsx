"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { refreshNotificationUnread } from "@/components/notification-unread";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import type { AdminNotificationRow } from "@/lib/notifications/admin-notifications";
import { adminNotificationHref, notificationStateLabels, notificationTimezone, type AdminNotificationQuery,
  type NotificationState } from "@/lib/notifications/admin-notification-query";
import { adminBookingLinkFrom } from "@/lib/bookings/admin-query";
import { transactionTimestamp } from "@/lib/payments/admin-query";
import { deleteNotificationsAction } from "./actions";
import { NotificationRetryButton } from "./notification-retry-button";

const errorLabels: Record<string, string> = {
  rejected: "Rejected by Brevo",
  unavailable: "Brevo temporarily unavailable",
  unconfirmed: "No response from Brevo (may have been sent)",
  not_configured: "Email is not configured",
  // Reported by Brevo's delivery webhook after it accepted the email.
  soft_bounce: "Soft bounce", hard_bounce: "Hard bounce", invalid_email: "Invalid email address",
  blocked: "Blocked by Brevo", error: "Brevo sending error",
};
const stateTones: Record<NotificationState, StatusTone> = { queued: "neutral", sending: "neutral", retrying: "warning", stopped: "danger", failed: "danger" };
const timestamp = (value: string) => transactionTimestamp(value, notificationTimezone);
const sortable: [string, AdminNotificationQuery["sort"], AdminNotificationQuery["dir"]][] = [
  ["Created", "created", "desc"], ["Status", "status", "asc"], ["Attempts", "attempts", "desc"], ["Next retry", "next_retry", "asc"],
];
const describe = (row: AdminNotificationRow) => `“${row.subject}” to ${row.recipient}`;
const consequences = "It will not be sent again. Booking, payment and refund records are not changed, and payment notices stay visible to the customer until they confirm them.";

// The page is remounted for every query (filters, sort, page), which clears the selection.
// Selection is limited to this page and to rows the server reports as deletable.
export function NotificationsTable({ rows, query }: { rows: AdminNotificationRow[]; query: AdminNotificationQuery }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<AdminNotificationRow[] | null>(null);
  const [pending, setPending] = useState(false);
  const selectAll = useRef<HTMLInputElement>(null);
  const deletable = rows.filter((row) => row.deletable);
  // A refresh may remove rows or make them ineligible; only visible deletable rows stay selected.
  const selected = deletable.filter((row) => chosen.has(row.id));
  const all = deletable.length > 0 && selected.length === deletable.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !all; }, [selected.length, all]);

  function toggle(id: string, on: boolean) {
    setChosen((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  }
  async function remove(targets: AdminNotificationRow[]) {
    if (pending) return;
    setPending(true);
    try {
      const result = await deleteNotificationsAction({ ids: targets.map((row) => row.id) });
      if (!result.ok) { toast.error(result.message); return; }
      const deleted = result.deleted.length;
      if (deleted) toast.success(deleted === 1 ? "Notification deleted." : `${deleted} notifications deleted.`);
      if (result.skipped) toast.warning(`${result.skipped} ${result.skipped === 1 ? "notification was" : "notifications were"} not deleted: `
        + "it is being sent, was retried or delivered, or no longer exists. The list has been refreshed.");
      setChosen(new Set()); setConfirming(null);
      router.refresh();
      refreshNotificationUnread();
    } catch { toast.error("Unable to delete notifications. Try again."); }
    finally { setPending(false); }
  }

  return <>
    {selected.length > 0 && <div role="toolbar" aria-label="Selected notifications"
      className="sticky top-2 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-card border border-primary/30 bg-success-background px-3 py-2 text-sm shadow-card">
      <span className="font-semibold text-primary">{selected.length} selected</span>
      <Button type="button" variant="destructive" size="small" fullWidth={false} className="gap-1.5" disabled={pending}
        onClick={() => setConfirming(selected)}><Trash2 aria-hidden size={14} />Delete selected</Button>
      <Button type="button" variant="subtle" size="small" fullWidth={false} disabled={pending} onClick={() => setChosen(new Set())}>Clear selection</Button>
    </div>}
    <div className="overflow-x-auto rounded-card border border-border bg-surface max-md:overflow-visible">
      <table aria-label="Undelivered notifications" className="w-full text-left text-sm max-md:block md:min-w-[840px]">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground max-md:block">
          <tr className="max-md:flex max-md:items-center max-md:px-3 max-md:py-2">
            <th scope="col" className="w-8 py-2.5 pl-3 pr-1 max-md:w-auto max-md:p-0">
              <label className="inline-flex min-h-8 items-center gap-2">
                <input ref={selectAll} type="checkbox" className="size-4 accent-primary" checked={all} disabled={!deletable.length || pending}
                  aria-label="Select all deletable notifications on this page"
                  onChange={(event) => setChosen(event.target.checked ? new Set(deletable.map((row) => row.id)) : new Set())} />
                <span className="md:sr-only">Select page</span>
              </label>
            </th>
            {[["Created", "created"], ["Notification", null], ["Booking", null], ["Status", "status"], ["Attempts", "attempts"], ["Next retry", "next_retry"], ["Actions", null]].map(([label]) => {
              const sort = sortable.find(([name]) => name === label);
              const active = sort && query.sort === sort[1];
              const Icon = active ? query.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
              return <th key={label} scope="col" aria-sort={sort ? active ? query.dir === "asc" ? "ascending" : "descending" : "none" : undefined}
                className={`whitespace-nowrap px-2.5 py-2.5 max-md:hidden ${label === "Attempts" ? "text-right" : ""} ${label === "Actions" ? "text-right" : ""}`}>
                {label === "Actions" ? <span className="sr-only">Actions</span> : sort
                  ? <Link scroll={false} href={adminNotificationHref({ ...query, sort: sort[1], dir: active ? query.dir === "asc" ? "desc" : "asc" : sort[2] }, 1)}
                    className="inline-flex items-center gap-1.5 hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{label}<Icon size={14} aria-hidden /></Link>
                  : label}
              </th>;
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border max-md:block">{rows.map((row) => <tr key={row.id}
          className={`align-top [&>td]:px-2.5 [&>td]:py-2.5 max-md:grid max-md:grid-cols-[1.75rem_minmax(0,1fr)] max-md:gap-x-2 max-md:gap-y-1 max-md:px-3 max-md:py-3 max-md:[&>td]:p-0 max-md:[&>td]:col-start-2 ${chosen.has(row.id) && row.deletable ? "bg-success-background/50" : ""}`}>
          <td className="pr-1! pl-3! max-md:col-start-1! max-md:row-span-6 max-md:p-0!">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary disabled:opacity-40" checked={row.deletable && chosen.has(row.id)}
              disabled={!row.deletable || pending} aria-label={`Select ${describe(row)}`}
              title={row.deletable ? undefined : "Only failed notifications or ones whose automatic retries have stopped can be deleted"}
              onChange={(event) => toggle(row.id, event.target.checked)} />
          </td>
          <td className="whitespace-nowrap max-md:order-3 max-md:text-xs max-md:text-muted-foreground"><time dateTime={row.created_at}>{timestamp(row.created_at)}</time></td>
          <td className="min-w-0 md:min-w-36 md:max-w-56 max-md:order-1">
            <span className="block font-medium text-foreground">{row.subject}</span>
            {row.account_user_id
              ? <Link href={`/admin/users/${row.account_user_id}`} title={row.recipient} className="block truncate text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus max-md:whitespace-normal max-md:break-all">{row.recipient}</Link>
              : <span title={row.recipient} className="block truncate text-xs text-muted-foreground max-md:whitespace-normal max-md:break-all">{row.recipient}</span>}
            {row.important && <span className="mt-1 inline-flex"><StatusBadge tone="danger">Financial exception</StatusBadge></span>}
          </td>
          <td className="max-md:order-4 max-md:text-xs">{row.booking_id
            ? <Link href={adminBookingLinkFrom(row.booking_id, adminNotificationHref(query))} title={row.booking_id}
              className="font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">
              <span aria-hidden="true">#{row.booking_id.slice(0, 8)}</span><span className="sr-only">Booking {row.booking_id}</span></Link>
            : <span className="text-muted-foreground">—</span>}</td>
          <td className="max-md:order-2">
            <StatusBadge tone={stateTones[row.state]}>{notificationStateLabels[row.state]}</StatusBadge>
            {row.last_error && <span className="mt-0.5 block text-xs text-muted-foreground">{errorLabels[row.last_error] ?? "Not delivered"}</span>}
            {row.failure_reason && <span title={row.failure_reason} className="mt-0.5 block max-w-56 truncate text-xs text-muted-foreground max-md:max-w-none max-md:whitespace-normal max-md:break-words">
              <span className="sr-only">Brevo reason: </span>{row.failure_reason}</span>}
            {row.failed_at && <span className="mt-0.5 block text-xs text-muted-foreground">Failed <time dateTime={row.failed_at}>{timestamp(row.failed_at)}</time></span>}
          </td>
          <td className="text-right tabular-nums max-md:order-5 max-md:text-left max-md:text-xs max-md:text-muted-foreground max-md:before:content-['Attempts:_']">{row.attempts}</td>
          <td className="whitespace-nowrap max-md:order-6 max-md:text-xs">{row.state === "stopped" || row.state === "failed"
            ? <span className="font-semibold text-danger" title="Not retried automatically; retry manually or dismiss">Stopped<span className="sr-only">: manual retry required</span></span>
            : row.state === "sending" ? <span className="text-muted-foreground">Sending now</span>
              : row.next_attempt_at && <span className="max-md:text-muted-foreground max-md:before:content-['Next_retry:_']"><time dateTime={row.next_attempt_at}>{timestamp(row.next_attempt_at)}</time></span>}</td>
          <td className="max-md:order-7 max-md:pt-1">
            <div className="flex items-center justify-end gap-1 whitespace-nowrap max-md:justify-start">
              <NotificationRetryButton id={row.id} />
              {row.deletable && <Button type="button" variant="subtle" size="icon" className="enabled:hover:bg-danger-background enabled:hover:text-danger" disabled={pending}
                aria-label={`Delete ${describe(row)}`} title="Delete" onClick={() => setConfirming([row])}><Trash2 aria-hidden size={16} /></Button>}
            </div>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    <ConfirmationDialog open={confirming !== null} pending={pending} confirmLabel={pending ? "Deleting…" : "Delete"}
      title={confirming && confirming.length > 1 ? `Delete ${confirming.length} notifications?` : "Delete notification?"}
      message={confirming?.length === 1 ? `${describe(confirming[0])}, created ${timestamp(confirming[0].created_at)}.\n\n${consequences}`
        : `${confirming?.length ?? 0} undelivered emails will be deleted. ${consequences}`}
      onClose={() => { if (!pending) setConfirming(null); }} onConfirm={() => { if (confirming) void remove(confirming); }} />
  </>;
}
