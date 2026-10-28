"use client";

import { useState, type ComponentProps } from "react";
import { NavigationLink } from "./navigation-pending";

// The containing row/card is relative. Independent actions sit above the stretched
// hit area with relative z-10; keyboard users follow the real link with Enter.
// A list renders one link per record, so each prefetches only on intent (pointer over
// the row, touch or focus) instead of every visible record prefetching its own route.
export function RowLink({ children, className = "", onMouseEnter, onTouchStart, onFocus, ...props }: ComponentProps<typeof NavigationLink>) {
  const [intent, setIntent] = useState(false);
  return <NavigationLink {...props} prefetch={intent ? props.prefetch : false} pendingPlacement="after"
    onMouseEnter={(event) => { setIntent(true); onMouseEnter?.(event); }}
    onTouchStart={(event) => { setIntent(true); onTouchStart?.(event); }}
    onFocus={(event) => { setIntent(true); onFocus?.(event); }}
    className={`after:absolute after:inset-0 after:content-[''] ${className}`}>
    {children}
  </NavigationLink>;
}
