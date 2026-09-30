"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ModalDialog } from "@/components/modal-dialog";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
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
        dialogRef.current?.close();
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
        <button
          type="button"
          disabled={pending || done}
          aria-describedby={error ? errorId : undefined}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={() => void mutate()}
        >
          {done ? "Restored" : pending ? "Restoring…" : "Restore"}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={pending || done}
          aria-expanded={confirming}
          aria-label={`Archive ${name}`}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          onClick={() => {
            setError("");
            setConfirming(true);
          }}
        >
          {done ? "Archived" : "Archive"}
        </button>
      )}
      {confirming &&
        !archived &&
        createPortal(
          <ModalDialog
            ref={dialogRef}
            active={confirming}
            aria-label={`Archive ${name}`}
            onCancel={(event) => {
              if (pending) event.preventDefault();
            }}
            onClose={() => {
              setConfirming(false);
              triggerRef.current?.focus();
            }}
            className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50"
          >
            <p className="text-sm">
              Archive {name}? It will leave normal management and become
              inactive.
            </p>
            <p
              id={errorId}
              role={error ? "alert" : undefined}
              className="min-h-5 pt-1 text-xs text-danger"
            >
              {error}
            </p>
            <div className="mt-3 flex justify-end gap-3 text-sm">
              <button
                type="button"
                disabled={pending}
                className="text-primary hover:underline"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                className="font-semibold text-primary hover:underline"
                onClick={() => void mutate()}
              >
                {pending ? "Archiving…" : "Confirm archive"}
              </button>
            </div>
          </ModalDialog>,
          document.body,
        )}
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
