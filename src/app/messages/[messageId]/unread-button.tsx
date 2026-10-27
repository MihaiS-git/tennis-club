"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { deleteMessageAction, markMessageReadAction, markMessageUnreadAction } from "../actions";

export function MessageDetailActions({ id, subject, returnHref }: { id: string; subject: string; returnHref: string }) {
  const [pending, start] = useTransition();
  // Reject synchronous re-entry as well as actions during the subsequent refresh.
  const pendingRef = useRef(false);
  const [operation, setOperation] = useState<"read" | "unread" | "delete" | null>(null);
  const [error, setError] = useState(false);
  const router = useRouter();
  function run(action: "read" | "unread" | "delete") {
    if (pendingRef.current || pending) return;
    pendingRef.current = true;
    setOperation(action);
    start(async () => {
      setError(false);
      try {
        if (action === "read") await markMessageReadAction(id);
        else if (action === "unread") await markMessageUnreadAction(id);
        else await deleteMessageAction(id);
        window.dispatchEvent(new Event("messages:changed"));
        if (action === "read") router.refresh(); else router.push(returnHref);
      } catch { setError(true); }
      finally { pendingRef.current = false; }
    });
  }
  return <div className="flex flex-wrap items-center justify-end gap-2">
    <Button type="button" variant="secondary" disabled={pending} aria-busy={pending && operation === "read"} onClick={() => run("read")}>
      {pending && operation === "read" ? "Marking read…" : "Mark read"}</Button>
    <Button type="button" variant="secondary" disabled={pending} aria-busy={pending && operation === "unread"} onClick={() => run("unread")}>
      {pending && operation === "unread" ? "Marking unread…" : "Mark unread"}</Button>
    <Button type="button" variant="destructive" size="icon" disabled={pending} aria-busy={pending && operation === "delete"}
      aria-label={`${pending && operation === "delete" ? "Deleting" : "Delete"} ${subject}`} onClick={() => run("delete")}>
      <Trash2 size={14} aria-hidden="true" className={pending && operation === "delete" ? "motion-safe:animate-pulse" : undefined} />
    </Button>
    <span role="status" className="sr-only">{pending && operation === "delete" ? "Deleting notification…" : ""}</span>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">Unable to update this notification. Try again.</p>}
  </div>;
}
