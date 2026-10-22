"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { inboxHref, type InboxQuery } from "@/lib/notifications/inbox-query";
import { deleteMessageAction, updateSelectedMessagesAction } from "./actions";

export type InboxRow = { id: string; category: string; subject: string; bodyText: string;
  read: boolean; createdAt: string; createdLabel: string };

export function InboxList({ rows, query, search }: { rows: InboxRow[]; query: InboxQuery; search: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const pageIds = rows.map((row) => row.id);
  const selectedIds = pageIds.filter((id) => selected.has(id));

  function refreshAfterMutation(deletedCount = 0) {
    window.dispatchEvent(new Event("messages:changed"));
    if (deletedCount >= rows.length && query.page > 1) router.replace(inboxHref({ ...query, page: query.page - 1 }));
    else router.refresh();
  }

  async function runSelected(operation: "read" | "unread" | "delete") {
    if (!selectedIds.length || pending) return;
    setPending(true); setError("");
    try {
      const result = await updateSelectedMessagesAction(selectedIds, operation);
      setSelected(new Set());
      setConfirming(false);
      refreshAfterMutation(operation === "delete" ? result.updated : 0);
    } catch { setError("Unable to update the selected notifications. Try again."); }
    finally { setPending(false); }
  }

  async function deleteOne(id: string) {
    if (pending) return;
    setPending(true); setError("");
    try {
      await deleteMessageAction(id);
      setSelected((current) => { const next = new Set(current); next.delete(id); return next; });
      refreshAfterMutation(rows.length === 1 ? 1 : 0);
    } catch { setError("Unable to delete this notification. Try again."); }
    finally { setPending(false); }
  }

  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-3 py-2 text-sm">
      <button type="button" disabled={!rows.length || pending} onClick={() => setSelected(new Set(pageIds))}
        className="min-h-9 rounded-control px-2 font-semibold text-primary hover:bg-surface disabled:opacity-50">Select page</button>
      <button type="button" disabled={!selectedIds.length || pending} onClick={() => setSelected(new Set())}
        className="min-h-9 rounded-control px-2 font-semibold text-primary hover:bg-surface disabled:opacity-50">Clear selection</button>
      <span className="mr-auto text-xs text-muted-foreground">{selectedIds.length} selected on this page</span>
      <button type="button" disabled={!selectedIds.length || pending} onClick={() => void runSelected("read")}
        className="min-h-9 rounded-control px-2 font-semibold text-primary hover:bg-surface disabled:opacity-50">Mark read</button>
      <button type="button" disabled={!selectedIds.length || pending} onClick={() => void runSelected("unread")}
        className="min-h-9 rounded-control px-2 font-semibold text-primary hover:bg-surface disabled:opacity-50">Mark unread</button>
      <button type="button" disabled={!selectedIds.length || pending} onClick={() => setConfirming(true)}
        className="min-h-9 rounded-control px-2 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Delete selected</button>
    </div>
    {error && <p role="alert" className="px-4 py-2 text-sm text-red-700">{error}</p>}
    <ul className="divide-y divide-border">
      {rows.map((message) => <li key={message.id} className={`flex min-w-0 items-center gap-2 px-3 ${message.read ? "text-muted-foreground" : "bg-surface text-primary"}`}>
        <input type="checkbox" aria-label={`Select ${message.subject}`} checked={selected.has(message.id)} disabled={pending}
          onChange={(event) => setSelected((current) => {
            const next = new Set(current);
            if (event.target.checked) next.add(message.id); else next.delete(message.id);
            return next;
          })} className="size-4 shrink-0 accent-primary" />
        <Link href={`/messages/${message.id}?${search}`} prefetch={false}
          className="grid min-w-0 flex-1 gap-1 py-3 transition hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
          <span className={`text-xs ${message.read ? "font-medium" : "font-bold"}`}>{message.category}{!message.read && <span className="ml-2 inline-block size-2 rounded-full bg-green-600" aria-label="Unread" />}</span>
          <span className="min-w-0 truncate text-sm"><span className={message.read ? "font-medium" : "font-semibold"}>{message.subject}</span><span className="ml-2 text-muted-foreground">— {message.bodyText.replace(/\s+/g, " ")}</span></span>
          <time dateTime={message.createdAt} className="text-xs whitespace-nowrap text-muted-foreground sm:text-right">{message.createdLabel}</time>
        </Link>
        <button type="button" disabled={pending} onClick={() => void deleteOne(message.id)} aria-label={`Delete ${message.subject}`}
          className="min-h-9 shrink-0 rounded-control px-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Delete</button>
      </li>)}
    </ul>
    <ConfirmationDialog open={confirming} title="Delete selected notifications?"
      message={`Delete ${selectedIds.length} selected notification${selectedIds.length === 1 ? "" : "s"} from this page?`}
      confirmLabel="Delete selected" pending={pending} onClose={() => setConfirming(false)}
      onConfirm={() => void runSelected("delete")} />
  </>;
}
