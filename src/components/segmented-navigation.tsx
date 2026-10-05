import type { ComponentProps } from "react";

export function SegmentedNavigation({ columns, className = "", ...props }: ComponentProps<"nav"> & {
  columns: 2 | 4 | 5;
}) {
  return <nav {...props} className={`flex min-w-0 max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-card border border-border bg-surface p-1 sm:grid sm:overflow-visible ${columns === 2 ? "sm:grid-cols-2" : columns === 4 ? "sm:grid-cols-4" : "sm:grid-cols-5"}${className ? ` ${className}` : ""}`} />;
}

export function segmentedNavigationItemClass(active: boolean, disabledCapable = false) {
  return `inline-flex min-h-12 shrink-0 items-center justify-center whitespace-nowrap rounded-control px-2 py-2 text-center text-xs font-medium leading-5 transition sm:min-h-14 sm:whitespace-normal sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${active
    ? "bg-primary text-primary-foreground"
    : `text-muted-foreground ${disabledCapable ? "enabled:hover:bg-surface-muted enabled:hover:text-primary" : "hover:bg-surface-muted hover:text-primary"}`}`;
}
