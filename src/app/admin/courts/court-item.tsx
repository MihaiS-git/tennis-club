"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminCourt } from "@/lib/admin/courts";
import type { AdminLocation } from "@/lib/admin/locations";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { courtSurfaceLabels, courtEnvironmentLabels } from "@/lib/admin/courts-validation";
import { CourtDialog } from "./court-dialog";
import { CoveragePeriods } from "./coverage-periods";

type LocationChoice = Pick<AdminLocation, "id" | "name" | "is_active">;

function CourtStatus({ active }: { active: boolean }) {
  return <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${active
    ? "bg-success-background text-success" : "bg-danger-background text-danger"}`}>
    {active ? "Active" : "Inactive"}
  </span>;
}

export function CourtItem({ court, locations, periods, mobile }: {
  court: AdminCourt; locations: LocationChoice[]; periods: CoveragePeriod[]; mobile?: boolean;
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
  if (mobile) return <>
    <article {...rowProps} role="button" className={`min-w-0 rounded-card border border-border-strong bg-surface p-5 ${hover}`}>
      <p className="break-words font-semibold text-foreground">{court.name}</p>
      <dl className="mt-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Status</dt><dd><CourtStatus active={court.is_active} /></dd>
        <dt className="text-muted-foreground">Surface</dt><dd>{courtSurfaceLabels[court.surface]}</dd>
        <dt className="text-muted-foreground">Environment</dt><dd>{courtEnvironmentLabels[court.environment]}</dd>
        <dt className="text-muted-foreground">Lighting</dt><dd>{court.has_lighting ? "Floodlit" : "No lighting"}</dd>
      </dl>
    </article>
    {court.environment === "outdoor" && <div className="rounded-card border border-border bg-surface p-5">
      <CoveragePeriods courtId={court.id} courtName={court.name} periods={periods} />
    </div>}
    {dialog}
  </>;
  return <><tbody className="border-t-2 border-border [&:first-of-type]:border-t-0">
    <tr {...rowProps} className={hover}>
      <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5">{court.name}</td>
      <td className="px-4 py-5 lg:px-5"><CourtStatus active={court.is_active} /></td>
      <td className="px-4 py-5 lg:px-5">{courtSurfaceLabels[court.surface]}</td>
      <td className="px-4 py-5 lg:px-5">{courtEnvironmentLabels[court.environment]}</td>
      <td className="px-4 py-5 lg:px-5">{court.has_lighting ? "Floodlit" : "No lighting"}</td>
    </tr>
    {court.environment === "outdoor" && <tr className="bg-surface-muted/40"><td colSpan={5} className="px-5 pb-3">
      <CoveragePeriods courtId={court.id} courtName={court.name} periods={periods} />
    </td></tr>}
  </tbody>{dialog}</>;
}
