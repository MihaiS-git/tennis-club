"use client";

import { toast } from "sonner";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { useLocationPanelActive } from "./location-workspace";
import { archiveLocationAction } from "./actions";

export function LocationArchiveControl({
  id,
  name,
  archived,
}: {
  id: string;
  name: string;
  archived: boolean;
}) {
  const panelActive = useLocationPanelActive();
  const router = useRouter();
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function mutate() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const notification = toast.loading(archived ? "Restoring location…" : "Archiving location…");
    try {
      const result = await archiveLocationAction({ id, archived: !archived });
      if (result.ok) {
        toast.success(archived ? "Location restored." : "Location archived.", { id: notification });
        setDone(true);
        setConfirming(false);
        router.refresh();
      } else
        toast.error(result.reason === "occupied" || result.reason === "not-ready" ? result.message
          : "This location is no longer available. Refresh and try again.", { id: notification });
    } catch {
      toast.error(
        `Unable to ${archived ? "restore" : "archive"} this location. Please try again.`, { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="relative inline-block">
      {archived ? (
        <Button
          type="button"
          disabled={pending || done}
          variant="subtle" size="small"
          onClick={() => void mutate()}
        >
          {done ? "Restored" : pending ? "Restoring…" : "Restore"}
        </Button>
      ) : (
        <Button
          ref={triggerRef}
          type="button"
          disabled={pending || done}
          aria-expanded={confirming}
          aria-label={`Archive ${name}`}
          variant="destructive" size="small"
          onClick={() => {
            setConfirming(true);
          }}
        >
          {done ? "Archived" : "Archive"}
        </Button>
      )}
      <ConfirmationDialog open={panelActive && confirming && !archived} title={`Archive ${name}`}
        message={`${name} will become inactive and unavailable in normal management and use.`}
        confirmLabel={pending ? "Archiving…" : "Archive location"} pending={pending}
        onConfirm={() => void mutate()} onClose={() => setConfirming(false)} returnFocusRef={triggerRef} />
    </div>
  );
}
