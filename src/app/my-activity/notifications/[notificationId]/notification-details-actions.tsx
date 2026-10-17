"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { refreshNotificationUnread } from "@/components/notification-unread";
import { manageNotificationsAction, markNotificationReadAction } from "../../actions";

export function NotificationDetailsActions({ id, read, backHref }: { id: string; read: boolean; backHref: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const opened = useRef<string | null>(null);
  // Effects run only when the message opens in the browser, never on server reads or prefetches.
  useEffect(() => {
    if (read || opened.current === id) return;
    opened.current = id;
    void markNotificationReadAction(id).then(result => {
      if (!result.ok) { toast.error(result.message); return; }
      refreshNotificationUnread();
    }).catch(() => { toast.error("Unable to update read status. Try opening the notification again."); });
  }, [id, read]);
  async function deleteNotification() {
    if (pending) return;
    setPending(true);
    try {
      const result = await manageNotificationsAction({ ids: [id], operation: "delete" });
      if (!result.ok) { toast.error(result.message); return; }
      refreshNotificationUnread();
      router.push(backHref);
      router.refresh();
    } catch { toast.error("Unable to save. Try again."); }
    finally { setPending(false); setDeleting(false); }
  }
  return <div className="flex items-center gap-2">
    <Button type="button" variant="destructive" size="icon" className="size-11" aria-label="Delete notification"
      disabled={pending} onClick={() => setDeleting(true)}><Trash2 aria-hidden="true" className="size-4" /></Button>
    <ConfirmationDialog open={deleting} title="Delete notification?" message="Remove this notification from your inbox? Financial alerts still require acknowledgment."
      confirmLabel="Delete from inbox" pending={pending} onClose={() => { if (!pending) setDeleting(false); }} onConfirm={() => void deleteNotification()} />
  </div>;
}
