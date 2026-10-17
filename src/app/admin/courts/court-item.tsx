"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminCourt } from "@/lib/admin/courts";
import type { AdminLocation } from "@/lib/admin/locations";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { CourtDialog } from "./court-dialog";
import { StatusBadge } from "@/components/status-badge";
import { CoveragePeriods } from "./coverage-periods";

type LocationChoice = Pick<AdminLocation, "id" | "name" | "is_active">;

function CourtStatus({ active }: { active: boolean }) {
  return <StatusBadge tone={active ? "success" : "neutral"}>{active ? "Active" : "Inactive"}</StatusBadge>;
}

export function CourtItem({ court, locations, periods, mobile, visible = true }: {
  court: AdminCourt; locations: LocationChoice[]; periods: CoveragePeriod[]; mobile?: boolean; visible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLElement | null) => { rowRef.current = element; },
    tabIndex: 0,
    "aria-label": `Edit court ${court.name}`,
    onClick: () => setOpen(true),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); }
    },
  };
  const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  const dialog = open && createPortal(<CourtDialog court={court} locations={locations} open onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) rowRef.current?.focus();
  }} />, document.body);
  // Mobile: one card per court; coverage sits under the court's summary, outside the clickable area.
  if (mobile) return <>
    <div hidden={!visible} className="min-w-0 overflow-hidden rounded-card border border-border bg-surface">
      <article {...rowProps} role="button" className={`min-w-0 p-4 ${hover}`}>
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 break-words font-semibold text-foreground">{court.name}</p>
          <CourtStatus active={court.is_active} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{courtSurfaceLabels[court.surface]} · {courtEnvironmentLabels[court.environment]} · {court.has_lighting ? "Floodlit" : "No lighting"}</p>
      </article>
      {court.environment === "outdoor" && <div className="border-t border-border bg-background px-4 py-2">
        <CoveragePeriods courtId={court.id} courtName={court.name} periods={periods} />
      </div>}
    </div>
    {dialog}
  </>;
  return <><tbody hidden={!visible} className="border-t border-border [&:first-of-type]:border-t-0">
    <tr {...rowProps} className={hover}>
      <td className="break-words px-4 py-3 font-semibold text-foreground">{court.name}</td>
      <td className="px-4 py-3"><CourtStatus active={court.is_active} /></td>
      <td className="px-4 py-3">{courtSurfaceLabels[court.surface]}</td>
      <td className="px-4 py-3">{courtEnvironmentLabels[court.environment]}</td>
      <td className="px-4 py-3">{court.has_lighting ? "Floodlit" : "No lighting"}</td>
    </tr>
    {court.environment === "outdoor" && <tr className="bg-background"><td colSpan={5} className="px-4 py-1.5">
      <CoveragePeriods courtId={court.id} courtName={court.name} periods={periods} />
    </td></tr>}
  </tbody>{dialog}</>;
}
