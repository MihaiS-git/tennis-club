"use client";

import { toast } from "sonner";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { setLocationPublicationAction } from "./actions";

export function PublicationControl({ id, published, blocked }: { id: string; published: boolean; blocked: boolean }) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  async function save() {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true);
    const operation = (async () => {
      const result = await setLocationPublicationAction({ id, is_public: !published }).catch(() => {
        throw new Error("Unable to change public booking. Please try again.");
      });
      if (!result.ok) throw new Error(result.reason === "not-ready" ? result.message : "Unable to change public booking. Refresh and try again.");
      router.refresh();
    })();
    toast.promise(operation, {
      id: `publication-${id}`,
      loading: "Updating public booking…",
      success: published ? "Public booking disabled." : "Public booking enabled.",
      error: (error: unknown) => error instanceof Error ? error.message : "Unable to change public booking. Please try again.",
    });
    try { await operation; } catch { /* Keep the control available for retry. */ }
    finally { pendingRef.current = false; setPending(false); }
  }
  return <div className="mt-3">
    <Button type="button" fullWidth={false} disabled={pending || (!published && blocked)} aria-busy={pending} onClick={() => void save()}>
      {pending ? "Saving…" : published ? "Disable public booking" : "Enable public booking"}
    </Button>
  </div>;
}
