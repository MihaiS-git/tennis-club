"use client";

import { useEffect, type ComponentProps, type RefObject } from "react";

let activeModalCount = 0;
let previousBodyOverflow = "";
let previousRootOverflow = "";

function lockDocumentScroll() {
  if (activeModalCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
  }
  activeModalCount += 1;

  return () => {
    activeModalCount -= 1;
    if (activeModalCount === 0) {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    }
  };
}

export function ModalDialog({ active, ref, style, children, ...props }: ComponentProps<"dialog"> & {
  active: boolean;
  ref: RefObject<HTMLDialogElement | null>;
}) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!active) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    return lockDocumentScroll();
  }, [active, ref]);

  return <dialog {...props} ref={ref} style={{ ...style, maxHeight: "calc(100dvh - 2rem)", overflowY: "auto" }}>{children}</dialog>;
}
