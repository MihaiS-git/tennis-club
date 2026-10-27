"use client";

import type { ComponentProps } from "react";
import { NavigationLink } from "./navigation-pending";

export function NavbarIconAction(props: Omit<ComponentProps<typeof NavigationLink>, "className" | "pendingPlacement" | "pendingSize">) {
  return <NavigationLink {...props} pendingPlacement="below"
    className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-control border border-border-strong p-0 text-primary hover:bg-surface-muted active:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary" />;
}
