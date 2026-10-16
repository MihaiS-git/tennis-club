"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { acknowledgeFinancialNoticeAction } from "./actions";

export function AcknowledgeNoticeButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function acknowledge() {
    if (pending) return;
    setPending(true);
    try {
      const result = await acknowledgeFinancialNoticeAction(id);
      if (!result.ok) toast.error(result.message);
      router.refresh();
    } catch { toast.error("Unable to save. Try again."); }
    finally { setPending(false); }
  }
  return <Button type="button" variant="secondary" size="small" fullWidth={false} className="mt-3"
    disabled={pending} aria-busy={pending} onClick={() => { void acknowledge(); }}>{pending ? "Saving…" : "OK"}</Button>;
}
