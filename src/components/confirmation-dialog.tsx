"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/button";
import { ModalDialog } from "@/components/modal-dialog";

export function ConfirmationDialog({ open, title, message, confirmLabel, cancelLabel = "Cancel", pending = false, confirmDisabled = false, error = "", onConfirm, onClose, returnFocusRef, children }: {
  children?: ReactNode;
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusTarget = returnFocusRef?.current;
    return () => { if (focusTarget?.isConnected) focusTarget.focus(); };
  }, [open, returnFocusRef]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()}
      onCancel={(event) => { event.stopPropagation(); if (pending) event.preventDefault(); }}
      onClose={(event) => { event.stopPropagation(); onClose(); returnFocusRef?.current?.focus(); }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
      <h2 id={titleId} className="font-heading text-lg font-semibold">{title}</h2>
      <p className="mt-3 whitespace-pre-line text-sm text-foreground">{message}</p>
      {children}
      <p role={error ? "alert" : undefined} className="min-h-5 pt-2 text-sm text-danger">{error}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="small" disabled={pending} onClick={() => dialogRef.current?.close()}>{cancelLabel}</Button>
        <Button type="button" variant="destructive" size="small" disabled={pending || confirmDisabled} aria-busy={pending} onClick={() => { if (!pending && !confirmDisabled) onConfirm(); }}>{confirmLabel}</Button>
      </div>
    </ModalDialog>, document.body,
  );
}
