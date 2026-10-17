"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { Pagination } from "@/components/pagination";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { inboxHref, inboxTypeLabels, inboxTypes, parseInboxQuery, type InboxQuery } from "@/lib/notifications/inbox-query";
import type { listOwnNotifications } from "@/lib/notifications/financial-notices";
import { manageNotificationsAction } from "./actions";
import { refreshNotificationUnread } from "@/components/notification-unread";

type Inbox = Awaited<ReturnType<typeof listOwnNotifications>>;
type Operation = "read" | "unread" | "delete";
const control = "min-h-10 rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-foreground";
const timestamp = (value: string) => new Date(value).toLocaleString("en-GB", { timeZone: "Europe/Bucharest" });
function typeLabel(kind: string) { return inboxTypes.includes(kind as keyof typeof inboxTypeLabels) ? inboxTypeLabels[kind as keyof typeof inboxTypeLabels] : "Booking update"; }

export function NotificationInbox({ inbox }: { inbox: Inbox }) {
  const { notices, query, total, totalPages } = inbox;
  const router = useRouter();
  const [search, setSearch] = useState(query.q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef(query);
  useEffect(() => { current.current = query; return () => clearTimeout(timer.current); }, [query]);
  const [chosen, setSelected] = useState<string[]>([]);
  const selected = notices.filter(notice => chosen.includes(notice.id)).map(notice => notice.id);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const deletionTargets = notices.filter(notice => deleting?.includes(notice.id)).map(notice => notice.id);
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && selected.length < notices.length;
  }, [selected.length, notices.length]);
  function navigate(patch: Partial<InboxQuery>) {
    clearTimeout(timer.current);
    setSelected([]);
    const next = { ...current.current, q: search.trim(), ...patch, page: 1 };
    current.current = next;
    router.replace(inboxHref(next), { scroll: false });
  }
  async function act(ids: string[], operation: Operation) {
    if (pending || !ids.length) return;
    setPending(true);
    try {
      const result = await manageNotificationsAction({ ids, operation });
      if (!result.ok) { toast.error(result.message); return; }
      setSelected([]); setDeleting(null);
      refreshNotificationUnread();
      router.refresh();
    } catch { toast.error("Unable to save. Try again."); }
    finally { setPending(false); }
  }
  function actions(ids: string[], individual = false) {
    const targets = notices.filter(notice => ids.includes(notice.id));
    return <>
      <Button type="button" variant="subtle" size="small" disabled={pending || !targets.some(notice => !notice.read_at)} onClick={() => void act(ids, "read")}>Mark as read</Button>
      <Button type="button" variant="subtle" size="small" disabled={pending || !targets.some(notice => notice.read_at)} onClick={() => void act(ids, "unread")}>Mark as unread</Button>
      <Button type="button" variant="destructive" size={individual ? "icon" : "small"}
        className={individual ? "size-11" : undefined} aria-label={individual ? "Delete notification" : undefined}
        disabled={pending || !targets.length} onClick={() => setDeleting(ids)}>{individual ? <Trash2 aria-hidden="true" className="size-4" /> : "Delete"}</Button>
    </>;
  }
  const hasFilters = search.trim() !== "" || query.q !== "" || query.status !== "all" || query.type !== "all";
  const clearFilters = hasFilters && <button type="button"
    className="inline-flex min-h-11 items-center whitespace-nowrap rounded-control px-2 text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    onClick={() => { setSearch(""); navigate({ q: "", status: "all", type: "all" }); }}>Clear filters</button>;
  return <section aria-label="Notification inbox" className="space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">Search notifications
        <input type="search" className={control} placeholder="Subject or message" maxLength={200} value={search} onChange={event => {
          const text = event.target.value;
          setSearch(text); clearTimeout(timer.current);
          timer.current = setTimeout(() => navigate({ q: text.trim() }), 350);
        }} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Status
        <select className={control} value={query.status} onChange={event => navigate({ status: parseInboxQuery({ status: event.target.value }).status })}>
          <option value="all">All notifications</option><option value="unread">Unread</option><option value="read">Read</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Type
        <select className={control} value={query.type} onChange={event => navigate({ type: parseInboxQuery({ type: event.target.value }).type })}>
          <option value="all">All types</option>{inboxTypes.map(kind => <option key={kind} value={kind}>{inboxTypeLabels[kind]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Sort
        <select className={control} value={query.sort} onChange={event => navigate({ sort: parseInboxQuery({ sort: event.target.value }).sort })}>
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
        </select>
      </label>
      {clearFilters}
    </div>
    <div className="flex flex-wrap items-center gap-3 rounded-control bg-surface-muted p-2 text-sm">
      <label className="flex min-h-9 items-center gap-2"><input ref={selectAll} type="checkbox" aria-label="Select all on this page"
        disabled={pending || !notices.length} checked={notices.length > 0 && selected.length === notices.length}
        onChange={event => setSelected(event.target.checked ? notices.map(notice => notice.id) : [])} />Select page</label>
      {selected.length > 0 ? <div role="toolbar" aria-label="Selected notification actions" className="flex flex-wrap items-center gap-2">
        <span>{selected.length} selected</span>{actions(selected)}
      </div> : <span className="text-muted-foreground">{total} notifications</span>}
    </div>
    {!notices.length && <div className="p-4 text-sm text-muted-foreground">
      <p>No notifications match your search and filters.</p>
      {clearFilters}
    </div>}
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {notices.map(notice => <li key={notice.id} className={`flex gap-3 p-3 ${notice.read_at ? "bg-surface" : "bg-surface-muted"}`}>
        <input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`Select ${notice.subject}`} disabled={pending}
          checked={selected.includes(notice.id)} onChange={event => setSelected(event.target.checked ? [...selected, notice.id] : selected.filter(id => id !== notice.id))} />
        <div className="min-w-0 flex-1">
          <Link className="block w-full text-left focus-visible:outline-2 focus-visible:outline-focus" href={inboxHref(query).replace("/notifications", `/notifications/${notice.id}`)}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className={notice.read_at ? "text-sm text-foreground" : "text-sm font-bold text-foreground"}>{notice.subject}</span>
              <time className="text-xs text-muted-foreground" dateTime={notice.created_at}>{timestamp(notice.created_at)}</time>
            </div>
            <span className="text-xs text-muted-foreground">{typeLabel(notice.event_kind)} · {notice.read_at ? "Read" : "Unread"}</span>
            <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{notice.text}</p>
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1" aria-label={`Actions for ${notice.subject}`}>{actions([notice.id], true)}</div>
        </div>
      </li>)}
    </ul>
    <Pagination currentPage={query.page} totalPages={totalPages} ariaLabel="Notification pages" scroll
      buildHref={(page) => inboxHref(query, { page })} />
    <ConfirmationDialog open={deleting !== null} title="Delete notifications?"
      message={`Remove ${deleting?.length ?? 0} notification(s) from your inbox? Financial alerts still require acknowledgment.`}
      confirmLabel="Delete from inbox" pending={pending} confirmDisabled={!deletionTargets.length} onClose={() => { if (!pending) setDeleting(null); }}
      onConfirm={() => { void act(deletionTargets, "delete"); }} />
  </section>;
}
