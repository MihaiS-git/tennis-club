"use client";

import { SortableTableHeading, type TableSortLink } from "@/components/sortable-table-heading";
import { CoachingDeleteButton } from "../delete-button";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import type { AdminCoachingCurrency, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import { coachingProgramTypeLabels, formatCoachingDuration, formatParticipants } from "@/lib/coaching/validation";
import { setCoachingProgramStatusAction } from "../actions";
import { coachingFailureMessages } from "../coaching-form";
import { ProgramDialog } from "./program-dialog";

const statusSelectClass = "min-h-9 rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60";
const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";

// Inline status edit: activation applies directly, deactivation confirms first.
function ProgramStatusControl({ program }: { program: AdminCoachingProgram }) {
  const router = useRouter();
  const selectRef = useRef<HTMLSelectElement>(null);
  // The ref fences re-entry before React renders; pending also spans the refresh.
  const pendingRef = useRef(false);
  const [pending, startTransition] = useTransition();
  const [isActive, showSavedValue] = useOptimistic(program.is_active);
  const [confirming, setConfirming] = useState(false);
  function save(active: boolean) {
    if (pendingRef.current || pending) return;
    pendingRef.current = true;
    startTransition(async () => {
      const notification = toast.loading("Updating program…");
      try {
        const result = await setCoachingProgramStatusAction({ id: program.id, is_active: active });
        if (result.ok) {
          toast.success(active ? "Program activated." : "Program deactivated.", { id: notification });
          setConfirming(false);
          startTransition(() => { showSavedValue(active); router.refresh(); });
        } else {
          toast.error(result.reason === "invalid-input" ? "Invalid program update." : coachingFailureMessages[result.reason], { id: notification });
        }
      } catch {
        toast.error("Unable to update program. Please try again.", { id: notification });
      } finally {
        pendingRef.current = false;
      }
    });
  }
  return <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <select ref={selectRef} aria-label={`Status of ${program.name}`} value={String(isActive)} disabled={pending} aria-busy={pending} className={statusSelectClass}
      onChange={(event) => { if (event.target.value === "true") save(true); else if (!pendingRef.current && !pending) setConfirming(true); }}>
      <option value="true">Active</option><option value="false">Inactive</option>
    </select>
    <ConfirmationDialog open={confirming} title={`Deactivate ${program.name}?`}
      message="The program will be hidden from the public Coaching page. Its prices and coach assignments are kept."
      confirmLabel="Deactivate program" pending={pending} returnFocusRef={selectRef}
      onClose={() => { if (!pendingRef.current) setConfirming(false); }} onConfirm={() => void save(false)} />
  </span>;
}

type PricingContext = { currencies?: AdminCoachingCurrency[]; prices?: AdminCoachingPrice[] };

function ProgramRow({ program, mobile, currencies, prices }: { program: AdminCoachingProgram; mobile?: boolean } & PricingContext) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLElement | null) => { rowRef.current = element; },
    tabIndex: 0,
    "aria-label": `Edit program ${program.name}`,
    onClick: () => setOpen(true),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); }
    },
  };
  const actions = <span className="inline-flex gap-2" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <CoachingDeleteButton kind="program" id={program.id} name={program.name} />
  </span>;
  const durations = program.durations.map(formatCoachingDuration).join(", ");
  const participants = formatParticipants(program.min_participants, program.max_participants) ?? "Not set";
  const rental = program.court_rental_included ? "Included" : "Not included";
  const dialog = open && createPortal(<ProgramDialog program={program} currencies={currencies}
    prices={prices?.filter((price) => price.program_id === program.id)}
    open onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) rowRef.current?.focus();
  }} />, document.body);
  if (mobile) return <>
    <article {...rowProps} role="button" className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words font-semibold text-foreground">{program.name}</p>
        <ProgramStatusControl program={program} />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{coachingProgramTypeLabels[program.program_type]} · {durations} · {participants}</p>
      <p className="text-sm text-muted-foreground">Court rental {rental.toLowerCase()}</p>
      <div className="mt-3">{actions}</div>
    </article>
    {dialog}
  </>;
  return <>
    <tr {...rowProps} className={hover}>
      <td className="px-4 py-3">
        <p className="break-words font-semibold text-foreground">{program.name}</p>
        {program.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{program.description}</p>}
      </td>
      <td className="px-4 py-3">{coachingProgramTypeLabels[program.program_type]}</td>
      <td className="px-4 py-3">{durations}</td>
      <td className="px-4 py-3">{participants}</td>
      <td className="px-4 py-3">{rental}</td>
      <td className="px-4 py-3"><ProgramStatusControl program={program} /></td>
      <td className="px-4 py-3">{actions}</td>
    </tr>
    {dialog}
  </>;
}

export function ProgramsTable({ programs, sortLinks, filtered = false, currencies, prices }: {
  programs: AdminCoachingProgram[]; sortLinks?: Record<string, TableSortLink>; filtered?: boolean;
} & PricingContext) {
  if (!programs.length) return <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
    {filtered ? "No coaching programs match these filters." : "No coaching programs yet. Create a program to describe a coaching offering, its durations and whether court rental is included."}
  </p>;
  return <section aria-label="Coaching programs">
    <div className="space-y-3 lg:hidden">{programs.map((program) => <ProgramRow key={program.id} program={program} currencies={currencies} prices={prices} mobile />)}</div>
    <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
      <table className="w-full table-fixed text-left font-sans text-sm" aria-label="Coaching programs">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>
            <SortableTableHeading label="Name" sort={sortLinks?.name} className="w-[30%] px-4 py-2.5" />
            <SortableTableHeading label="Type" sort={sortLinks?.type} />
            <th scope="col" className="px-4 py-2.5">Durations</th>
            <th scope="col" className="px-4 py-2.5">Players</th>
            <th scope="col" className="px-4 py-2.5">Court rental</th>
            <SortableTableHeading label="Status" sort={sortLinks?.status} className="w-32 px-4 py-2.5" />
            <th scope="col" className="w-28 px-4 py-2.5">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{programs.map((program) => <ProgramRow key={program.id} program={program} currencies={currencies} prices={prices} />)}</tbody>
      </table>
    </div>
  </section>;
}
