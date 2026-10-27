"use client";

import { SortableTableHeading, SortableTableLink, tableAriaSort, type TableSortLink } from "@/components/sortable-table-heading";
import type { AdminCoachListItem } from "@/lib/coaching/admin-lists";
import { Pencil } from "lucide-react";
import { Button } from "@/components/button";
import { CoachingDeleteButton } from "../delete-button";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import type { AdminCoach, AdminCoachingLocation, AdminCoachingProgram } from "@/lib/coaching/admin";
import { setCoachVisibilityAction } from "../actions";
import { coachingFailureMessages } from "../coaching-form";
import { CoachDialog } from "./coach-dialog";

const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
const cell = "px-3 py-3 align-top";
const heading = "px-3 py-2.5";
const ineligibilityLabels = { suspended: "Account suspended", "no-coach-role": "No Coach role" } as const;

// Inline visibility edit. Hidden coaches without a valid coach account cannot be shown.
function VisibilityControl({ coach }: { coach: AdminCoach }) {
  const router = useRouter();
  // The ref fences re-entry before React renders; pending also spans the refresh.
  const pendingRef = useRef(false);
  const [pending, startTransition] = useTransition();
  const [isPublic, showSavedValue] = useOptimistic(coach.is_public);
  function save(visible: boolean) {
    if (pendingRef.current || pending) return;
    pendingRef.current = true;
    startTransition(async () => {
      const notification = toast.loading("Updating visibility…");
      try {
        const result = await setCoachVisibilityAction({ user_id: coach.user_id, is_public: visible });
        if (result.ok) {
          toast.success(visible ? `${coach.display_name} is shown publicly.` : `${coach.display_name} is hidden.`, { id: notification });
          startTransition(() => { showSavedValue(visible); router.refresh(); });
        } else {
          toast.error(result.reason === "invalid-input" ? "Invalid visibility update." : coachingFailureMessages[result.reason], { id: notification });
        }
      } catch {
        toast.error("Unable to update visibility. Please try again.", { id: notification });
      } finally {
        pendingRef.current = false;
      }
    });
  }
  return <span className="inline-flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <select aria-label={`Visibility of ${coach.display_name}`} value={String(isPublic)} disabled={pending} aria-busy={pending}
      className="min-h-9 rounded-control border border-border-strong bg-surface px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
      onChange={event => save(event.target.value === "true")}>
      <option value="true" disabled={coach.ineligibility !== null && !isPublic}>Public</option>
      <option value="false">Hidden</option>
    </select>
    {coach.ineligibility && <StatusBadge tone="warning">{ineligibilityLabels[coach.ineligibility]}</StatusBadge>}
  </span>;
}

function names(ids: readonly string[], items: readonly { id: string; name: string }[], fallback: string) {
  const listed = ids.map((id) => items.find((item) => item.id === id)?.name ?? fallback);
  return listed.length ? listed.join(", ") : "None";
}

// Public only while a configured, unarchived profile is public; otherwise hidden.
function visibilityLabel(item: AdminCoachListItem) {
  return item.profile_status === "configured" && item.profile?.is_public ? "Public" : "Hidden";
}

// Name above a muted, fully wrapped email; an account without a name shows its email once.
function CoachIdentity({ item }: { item: AdminCoachListItem }) {
  const named = item.name !== item.email;
  return <div className="min-w-0">
    {named && <p className="break-words font-semibold text-foreground">{item.name}</p>}
    <p title={item.email} className={`[overflow-wrap:anywhere] ${named ? "text-xs text-muted-foreground" : "font-semibold text-foreground"}`}>{item.email}</p>
  </div>;
}

function CoachRow({ item, locations, programs, mobile }: {
  item: AdminCoachListItem; locations: AdminCoachingLocation[]; programs: AdminCoachingProgram[]; mobile?: boolean;
}) {
  const coach = item.profile;
  const editable = item.profile_status !== "archived";
  const name = item.name;
  const profileStatus = { configured: "Configured", "not-configured": "Not configured", archived: "Archived" }[item.profile_status];
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLElement | null) => { rowRef.current = element; },
    tabIndex: editable ? 0 : undefined,
    "aria-label": `${!editable ? "Archived coach" : coach ? "Edit coach" : "Configure profile"} ${name}`,
    onClick: () => { if (editable) setOpen(true); },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (editable) setOpen(true); }
    },
  };
  const dialog = open && editable && createPortal(<CoachDialog coach={coach ?? undefined}
    account={coach ? undefined : { id: item.user_id, email: item.email, suggested_name: item.name }} locations={locations} programs={programs} open onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) rowRef.current?.focus();
  }} />, document.body);
  const actions = editable ? <span className="inline-flex gap-2" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {!coach && <Button type="button" variant="secondary" size="small" className="gap-1.5 whitespace-nowrap" aria-label="Configure profile" onClick={() => setOpen(true)}><Pencil size={14} aria-hidden="true" />Configure profile</Button>}
    {coach && <CoachingDeleteButton kind="coach" id={coach.user_id} name={coach.display_name} />}
  </span> : <span className="text-xs text-muted-foreground">Archived</span>;
  const locationNames = names(coach?.location_ids ?? [], locations, "Archived location");
  const programNames = names(coach?.program_ids ?? [], programs, "Unavailable program");
  // Visibility is editable only on a configured profile.
  const visibility = coach && editable ? <VisibilityControl coach={coach} /> : visibilityLabel(item);
  if (mobile) return <>
    <article {...rowProps} role={editable ? "button" : undefined} className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
      <div className="flex items-start justify-between gap-3">
        <CoachIdentity item={item} />
        {visibility}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{item.account_status === "active" ? "Active" : "Suspended"} · {profileStatus}</p>
      <p className="mt-2 text-sm text-muted-foreground">Locations: {locationNames}</p>
      <p className="text-sm text-muted-foreground">Programs: {programNames}</p>
      <div className="mt-3">{actions}</div>
    </article>
    {dialog}
  </>;
  return <>
    <tr {...rowProps} className={hover}>
      <td className={cell}><CoachIdentity item={item} /></td>
      <td className={cell}>{item.account_status === "active" ? "Active" : "Suspended"}</td>
      <td className={cell}>{profileStatus}</td>
      <td className={cell}>{visibility}</td>
      <td className={`${cell} break-words`}>{locationNames}</td>
      <td className={`${cell} break-words`}>{programNames}</td>
      <td className={cell}>{actions}</td>
    </tr>
    {dialog}
  </>;
}

export function CoachesTable({ coaches, locations, programs, sortLinks, filtered = false }: {
  coaches: AdminCoachListItem[]; sortLinks?: Record<string, TableSortLink>; filtered?: boolean; locations: AdminCoachingLocation[]; programs: AdminCoachingProgram[];
}) {
  if (!coaches.length) return <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
    {filtered ? "No coaches match these filters." : "No accounts have the Coach role. Assign the role under Users."}
  </p>;
  return <section aria-label="Coaches">
    <div className="space-y-3 lg:hidden">{coaches.map((coach) => <CoachRow key={coach.user_id} item={coach} locations={locations} programs={programs} mobile />)}</div>
    <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
      <table className="w-full table-fixed text-left font-sans text-sm" aria-label="Coaches">
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>
            {/* The Coach column sorts by name or email. */}
            <th scope="col" className={`w-[21%] ${heading}`} aria-sort={tableAriaSort(sortLinks?.email?.direction ? sortLinks.email : sortLinks?.name)}>
              {sortLinks?.name && sortLinks.email ? <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <SortableTableLink label="Coach" sort={sortLinks.name} />
                <span className="font-normal"><SortableTableLink label="Email" sort={sortLinks.email} /></span>
              </span> : "Coach"}
            </th>
            <SortableTableHeading label="Account" sort={sortLinks?.status} className={`w-[9%] ${heading}`} />
            <SortableTableHeading label="Profile" sort={sortLinks?.profile} className={`w-[11%] ${heading}`} />
            <th scope="col" className={`w-[12%] ${heading}`}>Visibility</th>
            <th scope="col" className={heading}>Locations</th>
            <th scope="col" className={heading}>Programs</th>
            <th scope="col" className={`w-[19%] ${heading}`}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {coaches.map((coach) => <CoachRow key={coach.user_id} item={coach} locations={locations} programs={programs} />)}
        </tbody>
      </table>
    </div>
  </section>;
}
