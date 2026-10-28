"use client";

import type { ComponentProps } from "react";
import { NavigationLink } from "./navigation-pending";

export function NavbarIconAction({ variant = "icon", ...props }: Omit<ComponentProps<typeof NavigationLink>, "className" | "pendingPlacement" | "pendingSize"> & { variant?: "icon" | "avatar" }) {
  return <NavigationLink {...props} pendingPlacement="below"
    className={`relative inline-flex ${variant === "avatar" ? "size-12 rounded-full" : "size-10 rounded-control border border-border-strong"} shrink-0 items-center justify-center p-0 text-primary hover:bg-surface-muted active:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary`} />;
}
