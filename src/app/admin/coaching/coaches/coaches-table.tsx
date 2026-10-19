"use client";

import { Pencil } from "lucide-react";
import { Button } from "@/components/button";
import { CoachingDeleteButton } from "../delete-button";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import type { AdminCoach, AdminCoachingLocation, AdminCoachingProgram } from "@/lib/coaching/admin";
import { setCoachVisibilityAction } from "../actions";
import { coachingFailureMessages } from "../coaching-form";
import { CoachDialog } from "./coach-dialog";

const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
const ineligibilityLabels = { suspended: "Account suspended", "no-coach-role": "No Coach role" } as const;

// Inline visibility edit. Hidden coaches without a valid coach account cannot be shown.
function VisibilityControl({ coach }: { coach: AdminCoach }) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  async function save(isPublic: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true);
    const notification = toast.loading("Updating visibility…");
    try {
      const result = await setCoachVisibilityAction({ user_id: coach.user_id, is_public: isPublic });
      if (result.ok) {
        toast.success(isPublic ? `${coach.display_name} is shown publicly.` : `${coach.display_name} is hidden.`, { id: notification });
        router.refresh();
      } else {
        toast.error(result.reason === "invalid-input" ? "Invalid visibility update." : coachingFailureMessages[result.reason], { id: notification });
      }
    } catch {
      toast.error("Unable to update visibility. Please try again.", { id: notification });
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }
  return <span className="inline-flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <select aria-label={`Visibility of ${coach.display_name}`} value={String(coach.is_public)} disabled={pending}
      className="min-h-9 rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
      onChange={(event) => void save(event.target.value === "true")}>
      <option value="true" disabled={coach.ineligibility !== null && !coach.is_public}>Public</option>
      <option value="false">Hidden</option>
    </select>
    {coach.ineligibility && <StatusBadge tone="warning">{ineligibilityLabels[coach.ineligibility]}</StatusBadge>}
  </span>;
}

function names(ids: readonly string[], items: readonly { id: string; name: string }[]) {
  const listed = ids.flatMap((id) => items.find((item) => item.id === id)?.name ?? []);
  return listed.length ? listed.join(", ") : "None";
}

function CoachRow({ coach, locations, programs, mobile }: {
  coach: AdminCoach; locations: AdminCoachingLocation[]; programs: AdminCoachingProgram[]; mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLElement | null) => { rowRef.current = element; },
    tabIndex: 0,
    "aria-label": `Edit coach ${coach.display_name}`,
    onClick: () => setOpen(true),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); }
    },
  };
  const dialog = open && createPortal(<CoachDialog coach={coach} locations={locations} programs={programs} open onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) rowRef.current?.focus();
  }} />, document.body);
  const actions = <span className="inline-flex gap-2" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Button type="button" variant="secondary" size="small" aria-label="Edit coach" onClick={() => setOpen(true)}><Pencil size={14} aria-hidden="true" /></Button>
    <CoachingDeleteButton kind="coach" id={coach.user_id} name={coach.display_name} />
  </span>;
  const locationNames = names(coach.location_ids, locations);
  const programNames = names(coach.program_ids, programs);
  if (mobile) return <>
    <article {...rowProps} role="button" className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold text-foreground">{coach.display_name}</p>
          <p className="break-words text-xs text-muted-foreground">{coach.email}</p>
        </div>
        <VisibilityControl coach={coach} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Locations: {locationNames}</p>
      <p className="text-sm text-muted-foreground">Programs: {programNames}</p>
      <div className="mt-3">{actions}</div>
    </article>
    {dialog}
  </>;
  return <>
    <tr {...rowProps} className={hover}>
      <td className="px-4 py-3">
        <p className="break-words font-semibold text-foreground">{coach.display_name}</p>
        <p className="break-words text-xs text-muted-foreground">{coach.email}</p>
      </td>
      <td className="px-4 py-3"><VisibilityControl coach={coach} /></td>
      <td className="break-words px-4 py-3">{locationNames}</td>
      <td className="break-words px-4 py-3">{programNames}</td>
      <td className="px-4 py-3">{actions}</td>
    </tr>
    {dialog}
  </>;
}

export function CoachesTable({ coaches, locations, programs }: {
  coaches: AdminCoach[]; locations: AdminCoachingLocation[]; programs: AdminCoachingProgram[];
}) {
  if (!coaches.length) return <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
    No coach profiles yet. Add a coach for an active account with the Coach role.
  </p>;
  return <section aria-label="Coaches">
    <div className="space-y-3 lg:hidden">{coaches.map((coach) => <CoachRow key={coach.user_id} coach={coach} locations={locations} programs={programs} mobile />)}</div>
    <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
      <table className="w-full table-fixed text-left font-sans text-sm" aria-label="Coaches">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>
            <th scope="col" className="w-[28%] px-4 py-2.5">Coach</th>
            <th scope="col" className="w-[22%] px-4 py-2.5">Visibility</th>
            <th scope="col" className="px-4 py-2.5">Locations</th>
            <th scope="col" className="px-4 py-2.5">Programs</th>
            <th scope="col" className="w-28 px-4 py-2.5">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {coaches.map((coach) => <CoachRow key={coach.user_id} coach={coach} locations={locations} programs={programs} />)}
        </tbody>
      </table>
    </div>
  </section>;
}
