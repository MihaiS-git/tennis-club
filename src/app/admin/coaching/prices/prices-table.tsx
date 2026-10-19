"use client";

import { useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { AdminLocationSelect } from "@/components/admin-page-controls";
import { DialogHeader } from "@/components/dialog-layout";
import { ModalDialog } from "@/components/modal-dialog";
import type { AdminCoach, AdminCoachingLocation, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import { formatCoachingDuration } from "@/lib/coaching/validation";
import { formatMoney } from "@/lib/pricing/money";
import { PriceEditor } from "./price-editor";

export function PricesLocationSelect({ locations, selectedId }: { locations: AdminCoachingLocation[]; selectedId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return <AdminLocationSelect locations={locations} selectedId={selectedId}
    onChange={(value) => router.push(`${pathname}?location=${encodeURIComponent(value)}`, { scroll: false })} />;
}

type Row = { program: AdminCoachingProgram; durationMinutes: number };

function CoachPricesDialog({ row, location, coaches, prices }: {
  row: Row; location: AdminCoachingLocation; coaches: AdminCoach[]; prices: AdminCoachingPrice[];
}) {
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const title = `${row.program.name}, ${formatCoachingDuration(row.durationMinutes)}`;
  return <>
    <Button type="button" variant="secondary" size="small" fullWidth={false} onClick={() => setOpen(true)}
      aria-label={`Coach prices for ${title}`}>Coach prices</Button>
    <ModalDialog ref={dialogRef} active={open} aria-labelledby={`${prefix}-title`} onClose={() => setOpen(false)}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50">
      {open && <div className="p-5 sm:p-6">
        <div className="mb-4"><DialogHeader titleId={`${prefix}-title`} title="Coach prices" onClose={() => dialogRef.current?.close()} /></div>
        <p className="text-sm text-muted-foreground">{title} at {location.name}. A coach without an individual price uses the club price.</p>
        {coaches.length ? <ul className="mt-4 divide-y divide-border border-y border-border">
          {coaches.map((coach) => <li key={coach.user_id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <p className="pt-1.5 text-sm font-semibold text-foreground">{coach.display_name}</p>
            <PriceEditor label={`${coach.display_name} price for ${title}`} currency={location.currency} emptyHint="Club price"
              target={{ program_id: row.program.id, duration_minutes: row.durationMinutes, location_id: location.id, coach_user_id: coach.user_id }}
              price={prices.find((price) => price.coach_user_id === coach.user_id)} />
          </li>)}
        </ul> : <p className="mt-4 rounded-card border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
          No coach offers this program at this location. Assign coaches to the program and location under Coaches.
        </p>}
      </div>}
    </ModalDialog>
  </>;
}

export function PricesTable({ location, programs, coaches, prices }: {
  location: AdminCoachingLocation; programs: AdminCoachingProgram[]; coaches: AdminCoach[]; prices: AdminCoachingPrice[];
}) {
  const rows: Row[] = programs.flatMap((program) => program.durations.map((durationMinutes) => ({ program, durationMinutes })));
  if (!rows.length) return <p className="rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground">
    No coaching programs yet. Create a program with at least one duration under Programs, then set its prices here.
  </p>;
  const coachName = new Map(coaches.map((coach) => [coach.user_id, coach.display_name]));
  return <div className="overflow-x-auto rounded-card border border-border bg-surface">
    <table className="w-full min-w-[44rem] text-left font-sans text-sm" aria-label={`Coaching prices at ${location.name}`}>
      <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
        <tr>
          <th scope="col" className="px-4 py-2.5">Program</th>
          <th scope="col" className="px-4 py-2.5">Duration</th>
          <th scope="col" className="px-4 py-2.5">Club price</th>
          <th scope="col" className="px-4 py-2.5">Individual coach prices</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => {
          const matching = prices.filter((price) => price.program_id === row.program.id && price.duration_minutes === row.durationMinutes);
          const overrides = matching.filter((price) => price.coach_user_id !== null);
          const offering = coaches.filter((coach) => coach.program_ids.includes(row.program.id) && coach.location_ids.includes(location.id));
          const label = `${row.program.name}, ${formatCoachingDuration(row.durationMinutes)}`;
          return <tr key={`${row.program.id}-${row.durationMinutes}`} className="align-top">
            <td className="px-4 py-3">
              <p className="font-semibold text-foreground">{row.program.name}</p>
              <p className="text-xs text-muted-foreground">
                Court rental {row.program.court_rental_included ? "included" : "not included"}{row.program.is_active ? "" : " · Inactive"}
              </p>
            </td>
            <td className="whitespace-nowrap px-4 py-3">{formatCoachingDuration(row.durationMinutes)}</td>
            <td className="px-4 py-3">
              <PriceEditor label={`Club price for ${label}`} currency={location.currency} emptyHint="Not set"
                target={{ program_id: row.program.id, duration_minutes: row.durationMinutes, location_id: location.id, coach_user_id: null }}
                price={matching.find((price) => price.coach_user_id === null)} />
            </td>
            <td className="px-4 py-3">
              {overrides.length > 0 && <ul className="mb-2 space-y-0.5 text-sm">
                {overrides.map((price) => <li key={price.id} className={price.current ? "" : "text-danger"}>
                  {coachName.get(price.coach_user_id ?? "") ?? "Coach"}: {formatMoney(price.amount_minor, price.currency)}{price.current ? "" : " (re-enter)"}
                </li>)}
              </ul>}
              <CoachPricesDialog row={row} location={location} coaches={offering} prices={overrides} />
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
