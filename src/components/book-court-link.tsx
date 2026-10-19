"use client";

import { ProfileDepartureLink } from "./profile-departure-navigation";

export const startAnotherBookingEvent = "tennis-club:start-another-booking";

export function BookCourtLink({ className }: { className: string }) {
  return <ProfileDepartureLink href="/book" className={className} onClick={(event) => {
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey
      && !event.shiftKey && !event.altKey && window.location.pathname === "/book") {
      // Same-route navigation refreshes server data but preserves client state.
      window.dispatchEvent(new Event(startAnotherBookingEvent));
    }
  }}>Book a court</ProfileDepartureLink>;
}
