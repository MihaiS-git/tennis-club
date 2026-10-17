"use client";

import { Fragment, useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ProfileUnsavedChanges, useDirtyProfileSections } from "./unsaved-changes";

// Guards one Profile page's drafts. Sidebar and navbar departures share the
// registered handler; a completed departure starts the next visit fresh.
export function ProfileSettings({ path, children }: { path: string; children: ReactNode }) {
  const { bfcacheId } = useRouter();
  const [visit, setVisit] = useState(0);
  const leaveVisit = useCallback(() => setVisit((current) => current + 1), []);
  useLayoutEffect(() => () => {
    // Browser history can hide this subtree without discarding its draft state.
    leaveVisit();
  }, [leaveVisit]);
  return <ProfileUnsavedChanges onDeparture={leaveVisit} captureLinksFrom={path}>
    <Fragment key={`${bfcacheId}:${visit}`}>{children}</Fragment>
    <UnsavedMarker />
  </ProfileUnsavedChanges>;
}

// The sidebar sits outside this subtree; it styles its current link from this marker.
function UnsavedMarker() {
  return useDirtyProfileSections().length > 0 ? <span hidden data-profile-unsaved="" /> : null;
}
