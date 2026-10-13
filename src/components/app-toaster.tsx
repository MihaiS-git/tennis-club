"use client";

import { useLayoutEffect, useRef } from "react";
import { Toaster } from "sonner";

export function AppToaster() {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const originalParent = host.parentElement;
    const anchor = host.nextSibling;
    // Native modal dialogs make the rest of the document inert. Keep the single
    // Toaster in the active modal so notifications and actions remain accessible.
    // Move its host rather than remounting it or changing focus.
    function place() {
      const modal = Array.from(document.querySelectorAll("dialog[open]")).at(-1);
      const parent = modal ?? originalParent;
      if (parent && host && host.parentElement !== parent) parent.appendChild(host);
    }
    const observer = new MutationObserver(place);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    place();
    return () => {
      observer.disconnect();
      if (originalParent) originalParent.insertBefore(host, anchor?.parentNode === originalParent ? anchor : null);
    };
  }, []);
  return <div ref={hostRef} data-notification-host>
    <Toaster
      position="bottom-right"
      closeButton
      richColors
      gap={8}
      offset={16}
      mobileOffset={12}
      toastOptions={{
        classNames: {
          toast:
            "!w-[calc(100vw-1.5rem)] sm:!w-auto sm:!max-w-sm !rounded-xl !border !px-3 !py-2 !text-sm !shadow-[0_6px_16px_var(--shadow-neutral)]",
          title: "!text-sm !font-medium !leading-5",
          content: "!gap-0",
          icon: "!h-4 !w-4",
          closeButton:
            "!static !ml-1 !h-6 !w-6 !translate-y-0 !rounded-md !border-0 !bg-transparent !p-1 !text-[var(--toast-close-text)] hover:!bg-[var(--toast-close-hover-background)] hover:!text-[var(--toast-close-hover-text)]",
        },
      }}
    />
  </div>;
}
