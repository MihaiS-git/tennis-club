"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/button";
import { ModalDialog } from "@/components/modal-dialog";

export function ConfirmationDialog({ open, title, message, confirmLabel, pendingLabel, cancelLabel = "Cancel", pending = false, confirmDisabled = false, onConfirm, onClose, returnFocusRef, children, parentDialog }: {
  parentDialog?: HTMLDialogElement | null;
  children?: ReactNode;
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusTarget = returnFocusRef?.current;
    keepRef.current?.focus();
    return () => { if (focusTarget?.isConnected) focusTarget.focus(); };
  }, [open, returnFocusRef]);
  if (!open || typeof document === "undefined") return null;
  const content = <>
      <h2 id={titleId} className="font-heading text-lg font-semibold">{title}</h2>
      <p className="mt-3 whitespace-pre-line text-sm text-foreground">{message}</p>
      {children}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button ref={keepRef} type="button" variant="secondary" size="small" disabled={pending}
          onClick={() => { if (!pending) { if (parentDialog) onClose(); else dialogRef.current?.close(); } }}>{cancelLabel}</Button>
        <Button type="button" variant="destructive" size="small" disabled={pending || confirmDisabled} aria-busy={pending}
          onClick={() => { if (!pending && !confirmDisabled) onConfirm(); }}>{pending && pendingLabel ? pendingLabel : confirmLabel}</Button>
      </div>
    </>;
  // Details already owns a native modal and its focus trap. Keep confirmation in it.
  if (parentDialog) return createPortal(<section role="region" aria-labelledby={titleId}
    className="mt-4 rounded-control border border-border p-4">{content}</section>, parentDialog);
  return createPortal(
    <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()}
      onCancel={(event) => { event.stopPropagation(); if (pending) event.preventDefault(); }}
      onClose={(event) => { event.stopPropagation(); onClose(); returnFocusRef?.current?.focus(); }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
      {content}
    </ModalDialog>, document.body,
  );
}
