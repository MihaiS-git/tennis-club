import { NavigationLink } from "./navigation-pending";
import type { ComponentProps } from "react";

// The containing row/card is relative. Independent actions sit above the stretched
// hit area with relative z-10; keyboard users follow the real link with Enter.
export function RowLink({ children, className = "", ...props }: ComponentProps<typeof NavigationLink>) {
  return <NavigationLink {...props} pendingPlacement="after" className={`after:absolute after:inset-0 after:content-[''] ${className}`}>
    {children}
  </NavigationLink>;
}
