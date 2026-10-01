"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { archiveLocationAction } from "./actions";

export function LocationArchiveControl({
  id,
  name,
  archived,
  onSuccess,
}: {
  id: string;
  name: string;
  archived: boolean;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const errorId = useId();
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function mutate() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      const result = await archiveLocationAction({ id, archived: !archived });
      if (result.ok) {
        setDone(true);
        setConfirming(false);
        onSuccess?.();
        router.refresh();
      } else
        setError(
          "This location is no longer available. Refresh and try again.",
        );
    } catch {
      setError(
        `Unable to ${archived ? "restore" : "archive"} this location. Please try again.`,
      );
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
          aria-describedby={error ? errorId : undefined}
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
            setError("");
            setConfirming(true);
          }}
        >
          {done ? "Archived" : "Archive"}
        </Button>
      )}
      <ConfirmationDialog open={confirming && !archived} title={`Archive ${name}`}
        message={`${name} will become inactive and unavailable in normal management and use.`}
        confirmLabel={pending ? "Archiving…" : "Archive location"} pending={pending} error={error}
        onConfirm={() => void mutate()} onClose={() => setConfirming(false)} returnFocusRef={triggerRef} />
      {archived && error && (
        <p
          id={errorId}
          role="alert"
          className="text-xs text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
