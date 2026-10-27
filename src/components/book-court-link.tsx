"use client";

import { NavigationLink } from "./navigation-pending";

export const startAnotherBookingEvent = "tennis-club:start-another-booking";

export function BookCourtLink({ className, pendingSize = "small" }: { className: string; pendingSize?: "small" | "compact" }) {
  return <NavigationLink pendingPlacement="below" pendingSize={pendingSize} href="/book" className={`relative ${className}`} onClick={(event) => {
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey
      && !event.shiftKey && !event.altKey && window.location.pathname === "/book") {
      // Same-route navigation refreshes server data but preserves client state.
      window.dispatchEvent(new Event(startAnotherBookingEvent));
    }
  }}>Book a court</NavigationLink>;
}
