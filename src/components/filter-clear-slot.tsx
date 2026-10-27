import type { ReactNode } from "react";

// Filter toolbars always render this fixed-width slot, so showing or hiding Clear
// never resizes, wraps or repositions adjacent filter inputs. Inactive, it is empty.
export function FilterClearSlot({ active, className = "", children }: {
  active: boolean; className?: string; children: ReactNode;
}) {
  return <div data-filter-clear-slot="" className={`flex min-h-10 w-32 shrink-0 items-center ${className}`}>
    {active && children}
  </div>;
}
