"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { retryMessageDeliveryAction } from "../actions";

export function RetryDeliveryButton({ messageId, eligible, reason }: {
  messageId: string; eligible: boolean; reason: string;
}) {
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);
  const router = useRouter();
  return <div className="mt-4">
    <Button type="button" variant="secondary" disabled={pending || !eligible} onClick={() => start(async () => {
      setOutcome(null);
      try { setOutcome(await retryMessageDeliveryAction(messageId)); }
      catch { setOutcome("Unable to retry delivery. Refresh the details before trying again."); }
      router.refresh();
    })}>
      {pending ? "Retrying…" : "Retry now"}
    </Button>
    <p className="mt-2 text-sm text-muted-foreground" role="status">{outcome ?? reason}</p>
  </div>;
}
