import { LoadingStatus } from "@/components/loading-status";

export function BookingLoading() {
  // Mirror the controls and court/price row geometry without fixing page height.
  return <div className="mt-5 flex flex-col gap-5">
    <div aria-hidden="true" className="flex gap-2">
      <div className="h-10 w-36 rounded-control bg-surface-muted" />
      <div className="h-10 w-28 rounded-control bg-surface-muted" />
    </div>
    <div aria-hidden="true" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:p-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="space-y-2"><div className="h-4 w-16 bg-surface-muted" /><div className="h-7 w-60 bg-surface-muted" /><div className="h-4 w-40 bg-surface-muted" /></div>
      <div className="grid gap-3 sm:flex"><div className="h-14 w-full rounded-control bg-surface-muted sm:w-48" /><div className="h-14 w-full rounded-control bg-surface-muted sm:w-72" /></div>
    </div>
    <div className="flex flex-1 flex-col rounded-card border border-border bg-surface">
      <LoadingStatus label="Loading court availability…" className="justify-center p-4" />
      <div aria-hidden="true" className="flex-1 overflow-hidden rounded-b-card">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="flex h-17 border-t border-border">
          <div className="w-18 shrink-0 border-r border-border bg-surface-muted sm:w-28" />
          <div className="flex-1 bg-surface-muted/30" />
        </div>)}
      </div>
    </div>
  </div>;
}
