"use client";

import { useRouter } from "next/navigation";

export function CoachingControls({ locationId, date, programs, coaches, durations, programId, coachId, durationMinutes }: {
  locationId: string; date: string; programs: { id: string; name: string }[];
  coaches: { id: string; displayName: string }[]; durations: number[];
  programId: string; coachId: string; durationMinutes: number;
}) {
  const router = useRouter();
  const navigate = (field: "program" | "coach" | "duration", value: string) => {
    const params = new URLSearchParams({ mode: "coaching", location: locationId, date });
    if (programId) params.set("program", programId);
    if (coachId) params.set("coach", coachId);
    if (durationMinutes) params.set("duration", String(durationMinutes));
    params.set(field, value);
    if (field === "program") params.delete("duration");
    if (field === "coach") params.delete("duration");
    router.push(`/book?${params}`);
  };
  const selectClass = "mt-1 min-h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-base text-foreground sm:text-sm";
  return <fieldset className="mt-4 grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-3">
    <legend className="px-1 text-sm font-semibold text-primary">Coaching</legend>
    <label className="text-sm font-medium">Program
      <select aria-label="Program" value={programId} onChange={event => navigate("program", event.target.value)} className={selectClass}>
        {programs.map(program => <option key={program.id} value={program.id}>{program.name}</option>)}
      </select>
    </label>
    <label className="text-sm font-medium">Coach
      <select aria-label="Coach" value={coachId} disabled={!programId} onChange={event => navigate("coach", event.target.value)} className={selectClass}>
        <option value="" disabled>Choose a coach</option>
        {coaches.map(coach => <option key={coach.id} value={coach.id}>{coach.displayName}</option>)}
      </select>
    </label>
    <label className="text-sm font-medium">Lesson duration
      <select aria-label="Lesson duration" value={durationMinutes || ""} disabled={!coachId || !durations.length} onChange={event => navigate("duration", event.target.value)} className={selectClass}>
        <option value="" disabled>Choose a priced lesson length</option>
        {durations.map(duration => <option key={duration} value={duration}>{duration} min</option>)}
      </select>
    </label>
  </fieldset>;
}
