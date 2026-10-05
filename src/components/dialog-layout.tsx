import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/button";

export function DialogHeader({ titleId, title, status, onClose, disabled = false }: {
  titleId: string; title: string; status?: string; onClose: () => void; disabled?: boolean;
}) {
  return <header className="flex items-start justify-between gap-3 border-b border-border pb-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id={titleId} className="font-heading text-xl font-semibold text-primary">{title}</h2>
      {status && <span className="rounded-full bg-surface-muted px-2 py-1 text-xs font-semibold">{status}</span>}
    </div>
    <Button type="button" variant="subtle" size="icon" aria-label="Close dialog" disabled={disabled} onClick={onClose}><X aria-hidden className="size-5" /></Button>
  </header>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <footer className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">{children}</footer>;
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-4">
    <h3 className="mb-2 text-sm font-semibold text-primary">{title}</h3>
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm [&_dd]:break-words">{children}</dl>
  </section>;
}
