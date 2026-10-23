"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryMessageDeliveryAction } from "../actions";

export function RetryDeliveryButton({ messageId, eligible, reason }: {
  messageId: string; eligible: boolean; reason: string;
}) {
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);
  const router = useRouter();
  return <div className="mt-4">
    <button type="button" disabled={pending || !eligible} onClick={() => start(async () => {
      setOutcome(null);
      try { setOutcome(await retryMessageDeliveryAction(messageId)); }
      catch { setOutcome("Unable to retry delivery. Refresh the details before trying again."); }
      router.refresh();
    })} className="min-h-10 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary hover:bg-surface-muted disabled:opacity-60">
      {pending ? "Retrying…" : "Retry now"}
    </button>
    <p className="mt-2 text-sm text-muted-foreground" role="status">{outcome ?? reason}</p>
  </div>;
}
