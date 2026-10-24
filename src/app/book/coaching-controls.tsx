"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { formatMoney } from "@/lib/pricing/money";
import type { CoachingDurationOption } from "@/lib/coaching/booking-options";

const dependents = { coach: ["program", "duration", "participants"], program: ["duration", "participants"], duration: [], participants: [] } as const;

export function CoachingControls({ locationId, date, coaches, programs, durations, participants, coachId, programId, durationMinutes, participantCount, courtRentalIncluded }: {
  locationId: string; date: string;
  coaches: { id: string; displayName: string }[];
  // The selected coach's own program assignments; empty until a coach is chosen.
  programs: { id: string; name: string }[];
  durations: CoachingDurationOption[];
  // The selected program's configured participant range; null until a program is chosen.
  participants: { min: number; max: number } | null;
  coachId: string; programId: string; durationMinutes: number; participantCount: number; courtRentalIncluded: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Changing a selection clears every downstream selection; the server
  // resolves options and lesson starts for the new URL.
  const navigate = (field: keyof typeof dependents, value: string) => {
    const params = new URLSearchParams({ mode: "coaching", location: locationId, date });
    if (coachId) params.set("coach", coachId);
    if (programId) params.set("program", programId);
    if (durationMinutes) params.set("duration", String(durationMinutes));
    if (participantCount) params.set("participants", String(participantCount));
    params.set(field, value);
    for (const key of dependents[field]) params.delete(key);
    startTransition(() => router.push(`/book?${params}`, { scroll: false }));
  };
  const selected = durations.find(item => item.durationMinutes === durationMinutes);
  const counts = participants ? Array.from({ length: participants.max - participants.min + 1 }, (_, index) => participants.min + index) : [];
  const selectClass = "mt-1 min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm";
  return <fieldset aria-busy={pending} className="mt-4 grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
    <legend className="px-1 text-sm font-semibold text-primary">Coaching</legend>
    <label className="text-sm font-medium">Coach
      <select aria-label="Coach" value={coachId} disabled={pending || !coaches.length} onChange={event => navigate("coach", event.target.value)} className={selectClass}>
        <option value="" disabled>{coaches.length ? "Choose a coach" : "No coaches at this location"}</option>
        {coaches.map(coach => <option key={coach.id} value={coach.id}>{coach.displayName}</option>)}
      </select>
    </label>
    <label className="text-sm font-medium">Program
      <select aria-label="Program" value={programId} disabled={pending || !coachId || !programs.length} onChange={event => navigate("program", event.target.value)} className={selectClass}>
        <option value="" disabled>{!coachId ? "Choose a coach first" : programs.length ? "Choose a program" : "No programs assigned"}</option>
        {programs.map(program => <option key={program.id} value={program.id}>{program.name}</option>)}
      </select>
    </label>
    <label className="text-sm font-medium">Lesson duration
      <select aria-label="Lesson duration" value={durationMinutes || ""} disabled={pending || !programId || !durations.length} onChange={event => navigate("duration", event.target.value)} className={selectClass}>
        <option value="" disabled>{programId ? "Choose a lesson length" : "Choose a program first"}</option>
        {durations.map(({ durationMinutes: minutes, price }) => <option key={minutes} value={minutes}>
          {minutes} min · {price ? formatMoney(price.amountMinor, price.currency) : "price unavailable"}
        </option>)}
      </select>
    </label>
    <label className="text-sm font-medium">Players
      <select aria-label="Players" value={participantCount || ""} disabled={pending || !programId || !counts.length} onChange={event => navigate("participants", event.target.value)} className={selectClass}>
        <option value="" disabled>{programId ? "Choose the number of players" : "Choose a program first"}</option>
        {counts.map(count => <option key={count} value={count}>{count} {count === 1 ? "player" : "players"}</option>)}
      </select>
    </label>
    {pending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
      <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />Loading lesson options…
    </p> : selected?.price && <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
      Coaching price: <strong className="tabular-nums text-primary">{formatMoney(selected.price.amountMinor, selected.price.currency)}</strong>
      {selected.price.source === "coach" ? " (coach’s price)" : " (club price)"} · {courtRentalIncluded ? "Court rental included" : "Court rental charged separately at the court’s rate"}
    </p>}
  </fieldset>;
}
