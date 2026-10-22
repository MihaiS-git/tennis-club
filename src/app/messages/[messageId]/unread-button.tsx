"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteMessageAction, markMessageReadAction, markMessageUnreadAction } from "../actions";

export function MessageDetailActions({ id, returnHref }: { id: string; returnHref: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  const router = useRouter();
  function run(operation: "read" | "unread" | "delete") {
    start(async () => {
      setError(false);
      try {
        if (operation === "read") await markMessageReadAction(id);
        else if (operation === "unread") await markMessageUnreadAction(id);
        else await deleteMessageAction(id);
        window.dispatchEvent(new Event("messages:changed"));
        if (operation === "read") router.refresh(); else router.push(returnHref);
      } catch { setError(true); }
    });
  }
  return <div className="flex flex-wrap justify-end gap-2">
    <button type="button" disabled={pending} onClick={() => run("read")}
      className="min-h-10 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary hover:bg-surface-muted disabled:opacity-60">Mark read</button>
    <button type="button" disabled={pending} onClick={() => run("unread")}
      className="min-h-10 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary hover:bg-surface-muted disabled:opacity-60">Mark unread</button>
    <button type="button" disabled={pending} onClick={() => run("delete")}
      className="min-h-10 rounded-control border border-border-strong px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60">Delete</button>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">Unable to update this notification. Try again.</p>}
  </div>;
}
