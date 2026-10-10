"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { SegmentedNavigation, segmentedNavigationItemClass } from "@/components/segmented-navigation";
import { ProfileUnsavedChanges, useDirtyProfileSections } from "@/app/profile/unsaved-changes";

const tabs = [
  { id: "details", label: "Details" },
  { id: "opening-hours", label: "Opening hours" },
  { id: "courts", label: "Courts" },
  { id: "pricing", label: "Pricing" },
  { id: "public-booking", label: "Public booking" },
] as const;
const sectionLabels = { Details: "Details", "Opening hours": "Opening hours", Pricing: "Pricing", Courts: "Courts" };

const ActiveLocationPanelContext = createContext(true);

// Global court/pricing views have no workspace provider and stay active.
export function useLocationPanelActive() {
  return useContext(ActiveLocationPanelContext);
}

type WorkspacePanels = Record<typeof tabs[number]["id"], ReactNode>;

export function LocationWorkspace({ panels }: { panels: WorkspacePanels }) {
  const pathname = usePathname();
  const [visit, setVisit] = useState(0);
  const leave = useCallback(() => setVisit((current) => current + 1), []);
  return <ProfileUnsavedChanges onDeparture={leave} sectionLabels={sectionLabels} captureLinksFrom={pathname}>
    <LocationWorkspaceContent key={visit} panels={panels} />
  </ProfileUnsavedChanges>;
}

function LocationWorkspaceContent({ panels }: { panels: WorkspacePanels }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.getAll("tab");
  const selected = requested.length === 1 && tabs.some(({ id }) => id === requested[0]) ? requested[0] : "details";
  const dirty = useDirtyProfileSections();
  return <div onClickCapture={(event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self")) return;
    const target = new URL(anchor.href);
    if (target.origin !== window.location.origin || target.pathname !== pathname || !target.searchParams.has("tab")) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.href !== window.location.href) window.history.pushState(null, "", `${target.pathname}${target.search}${target.hash}`);
  }}>
    <SegmentedNavigation columns={5} aria-label="Location management" className="mb-5">
      {tabs.map(({ id, label }) => {
        const query = new URLSearchParams(searchParams);
        query.set("tab", id);
        const href = `${pathname}?${query}`;
        const hasDraft = dirty.some((section) => section === label || section.startsWith(`${label} `));
        return <Link key={id} href={href} aria-current={selected === id ? "page" : undefined}
          className={segmentedNavigationItemClass(selected === id)}>
          {label}{hasDraft && <span className="ml-1" role="img" aria-label="Unsaved changes">•</span>}
        </Link>;
      })}
    </SegmentedNavigation>
    {tabs.map(({ id, label }) => <section key={id} hidden={selected !== id} aria-label={label}
      className="min-w-0 rounded-control border border-border bg-surface p-4 sm:p-6">
      <ActiveLocationPanelContext value={selected === id}>{panels[id]}</ActiveLocationPanelContext>
    </section>)}
  </div>;
}
