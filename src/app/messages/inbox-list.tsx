"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { inboxHref, type InboxQuery } from "@/lib/notifications/inbox-query";
import { deleteMessageAction, updateSelectedMessagesAction } from "./actions";
import { NavigationLink } from "@/components/navigation-pending";

export type InboxRow = { id: string; category: string; subject: string; bodyText: string;
  read: boolean; createdAt: string; createdLabel: string };

type InboxOperation = { kind: "selection"; action: "read" | "unread" | "delete" }
  | { kind: "delete"; messageId: string };

export function InboxList({ rows, query, search }: { rows: InboxRow[]; query: InboxQuery; search: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const pendingRef = useRef(false);
  const [pending, startTransition] = useTransition();
  const [operation, setOperation] = useState<InboxOperation | null>(null);
  const [error, setError] = useState("");
  const pageIds = rows.map((row) => row.id);
  const selectedIds = pageIds.filter((id) => selected.has(id));

  function run(nextOperation: InboxOperation) {
    if (pendingRef.current || pending || (nextOperation.kind === "selection" && !selectedIds.length)) return;
    pendingRef.current = true;
    setOperation(nextOperation);
    setError("");
    startTransition(async () => {
      try {
        let deletedCount = 0;
        if (nextOperation.kind === "selection") {
          const result = await updateSelectedMessagesAction(selectedIds, nextOperation.action);
          if (nextOperation.action === "delete") deletedCount = result.updated;
          setSelected(new Set());
          setConfirming(false);
        } else {
          await deleteMessageAction(nextOperation.messageId);
          deletedCount = 1;
          setSelected(current => {
            const next = new Set(current);
            next.delete(nextOperation.messageId);
            return next;
          });
        }
        window.dispatchEvent(new Event("messages:changed"));
        startTransition(() => {
          if (deletedCount >= rows.length && query.page > 1) router.replace(inboxHref({ ...query, page: query.page - 1 }));
          else router.refresh();
        });
      } catch {
        setError(nextOperation.kind === "selection" ? "Unable to update the selected notifications. Try again."
          : "Unable to delete this notification. Try again.");
      } finally { pendingRef.current = false; }
    });
  }
  const selectedAction = pending && operation?.kind === "selection" ? operation.action : null;
  const deletingMessageId = pending && operation?.kind === "delete" ? operation.messageId : null;

  return <>
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-3 py-2 text-sm">
      <Button type="button" variant="secondary" size="small" disabled={!rows.length || pending} onClick={() => setSelected(new Set(pageIds))}>Select page</Button>
      <Button type="button" variant="secondary" size="small" disabled={!selectedIds.length || pending} onClick={() => setSelected(new Set())}>Clear selection</Button>
      <span className="mr-auto text-xs text-muted-foreground">{selectedIds.length} selected on this page</span>
      <Button type="button" variant="secondary" size="small" disabled={!selectedIds.length || pending} onClick={() => run({ kind: "selection", action: "read" })}>{selectedAction === "read" ? "Marking read…" : "Mark read"}</Button>
      <Button type="button" variant="secondary" size="small" disabled={!selectedIds.length || pending} onClick={() => run({ kind: "selection", action: "unread" })}>{selectedAction === "unread" ? "Marking unread…" : "Mark unread"}</Button>
      <Button type="button" variant="destructive" size="small" disabled={!selectedIds.length || pending} onClick={() => setConfirming(true)}>{selectedAction === "delete" ? "Deleting…" : "Delete selected"}</Button>
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
        <NavigationLink pendingPlacement="below" href={`/messages/${message.id}?${search}`} prefetch={false}
          className="grid min-w-0 flex-1 gap-1 py-3 transition hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
          <span className={`relative w-fit text-xs ${message.read ? "font-medium" : "font-bold"}`}>{message.category}{!message.read && <span className="ml-2 inline-block size-2 rounded-full bg-green-600" aria-label="Unread" />}</span>
          <span className="min-w-0 truncate text-sm"><span className={message.read ? "font-medium" : "font-semibold"}>{message.subject}</span><span className="ml-2 text-muted-foreground">— {message.bodyText.replace(/\s+/g, " ")}</span></span>
          <time dateTime={message.createdAt} className="text-xs whitespace-nowrap text-muted-foreground sm:text-right">{message.createdLabel}</time>
        </NavigationLink>
        <Button type="button" variant="destructive" size="icon" disabled={pending}
          aria-busy={deletingMessageId === message.id} onClick={() => run({ kind: "delete", messageId: message.id })}
          aria-label={`${deletingMessageId === message.id ? "Deleting" : "Delete"} ${message.subject}`}>
          <Trash2 size={14} aria-hidden="true" className={deletingMessageId === message.id ? "motion-safe:animate-pulse" : undefined} />
        </Button>
      </li>)}
    </ul>
    <span role="status" className="sr-only">{deletingMessageId ? "Deleting notification…" : ""}</span>
    <ConfirmationDialog open={confirming} title="Delete selected notifications?"
      message={`Delete ${selectedIds.length} selected notification${selectedIds.length === 1 ? "" : "s"} from this page?`}
      confirmLabel="Delete selected" pendingLabel="Deleting…" pending={pending} onClose={() => { if (!pendingRef.current && !pending) setConfirming(false); }}
      onConfirm={() => run({ kind: "selection", action: "delete" })} />
  </>;
}
