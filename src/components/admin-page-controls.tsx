import { FilterPendingIndicator } from "@/components/navigation-pending";
import type { ReactNode } from "react";

// One compact header for every Admin page, matching the My activity and Profile areas.
export function AdminPageHeader({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return <header className="mb-6">
    <h1 className="break-words font-heading text-3xl font-semibold text-primary">{title}</h1>
    <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>
    {children && <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>}
  </header>;
}

export function AdminToolbar({ primary, action, filters, metadata, pending = false }: {
  primary: ReactNode;
  action?: ReactNode;
  filters?: ReactNode;
  metadata?: ReactNode;
  pending?: boolean;
}) {
  return <div className="relative mb-4 flex flex-wrap items-end gap-3 text-sm">
    {primary}
    {filters}
    {metadata && <div className="min-w-60 flex-1 pb-2 text-sm text-muted-foreground">{metadata}</div>}
    <FilterPendingIndicator pending={pending} />
    {action && <div className="ml-auto">{action}</div>}
  </div>;
}
