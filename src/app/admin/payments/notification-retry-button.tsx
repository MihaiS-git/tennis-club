"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { refreshNotificationUnread } from "@/components/notification-unread";
import { retryNotificationAction } from "./actions";

const results: Record<string, string> = {
  accepted: "Email accepted by Brevo; awaiting delivery confirmation.", already_delivered: "This email was already accepted by Brevo.",
  rejected: "Brevo rejected the email again.", unavailable: "Brevo is temporarily unavailable; the email will be retried.",
  unconfirmed: "Brevo did not respond; the email may have been sent.",
  not_configured: "Email is not configured on the server.",
};

export function NotificationRetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function retry() {
    if (pending) return;
    setPending(true);
    try {
      const outcome = await retryNotificationAction({ id });
      if (!outcome.ok) toast.error(outcome.message);
      else if (outcome.result === "accepted" || outcome.result === "already_delivered") toast.success(results[outcome.result]);
      else toast.error(results[outcome.result]);
      router.refresh();
      refreshNotificationUnread();
    } catch { toast.error("Unable to retry this email. Try again."); }
    finally { setPending(false); }
  }
  return <Button type="button" variant="secondary" size="small" fullWidth={false} disabled={pending} aria-busy={pending}
    onClick={() => { void retry(); }}>{pending ? "Sending…" : "Retry now"}</Button>;
}
