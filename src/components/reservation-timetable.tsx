"use client";

import { CourtTimelineGrid } from "@/components/court-timeline-grid";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { ReservationCell, ReservationSelection } from "@/lib/reservations/domain";

export type ReservationTimetableDay = {
  times: number[];
  courts: { court: { id: string; name: string }; cells: ReservationCell[] }[];
};
export type OccupiedInterval = { id: string; courtId: string; startsAtMinute: number; endsAtMinute: number; label: string; kind?: "booking" | "reservation" };

const styles = {
  available: "bg-success-background text-primary",
  booked: "bg-danger-background text-danger",
  closed: "bg-danger-background text-danger",
  past: "bg-danger-background text-danger",
} as const;

export function ReservationTimetable({ day, date, timezone, selection, onChoose, occupiedIntervals = [], onOccupiedClick, disabled = false }: {
  day: ReservationTimetableDay; date: string; timezone?: string; selection: ReservationSelection | null;
  onChoose: (courtId: string, cells: ReservationCell[], row: number) => void;
  occupiedIntervals?: OccupiedInterval[]; onOccupiedClick?: (id: string) => void; disabled?: boolean;
}) {
  if (day.times.length === 0) return <p className="mt-4 text-sm text-muted-foreground">Closed on this date.</p>;
  const firstActionableMinute = day.times.find((_, index) => day.courts.some(({ cells }) => cells[index] === "available" && (cells[index - 1] === "available" || cells[index + 1] === "available")));
  return <>
    <p className="mt-3 text-xs text-muted-foreground">Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust.</p>
    <CourtTimelineGrid times={day.times} rows={day.courts} date={date} timezone={timezone}
      selectedStartMinute={selection?.startMinute} selectedEndMinute={selection?.endMinute} firstActionableMinute={firstActionableMinute}
      renderCells={({ court, cells }) => {
        // Occupancy-only callers retain generic labels. Never derive identity or
        // manageability from an occupied cell; those come from the caller's read model.
        const intervals = occupiedIntervals.filter((item) => item.courtId === court.id);
        return day.times.map((minute, row) => {
          const occupied = intervals.find((item) => item.startsAtMinute < minute + 30 && minute < item.endsAtMinute);
          if (occupied) {
            if (row > 0 && day.times[row - 1] + 30 > occupied.startsAtMinute) return null;
            const span = day.times.filter((time) => time >= minute && time < occupied.endsAtMinute).length;
            const label = `${court.name} ${date} ${minuteToTime(occupied.startsAtMinute)}–${minuteToTime(occupied.endsAtMinute)}, ${occupied.label}`;
            const blockStyle = occupied.kind === "reservation" ? "bg-[var(--clay-300)] text-primary" : styles.booked;
            return <div key={`${minute}:${occupied.id}`} role="cell" aria-colspan={span} style={{ gridColumn: `${row + 2} / span ${span}` }} className="min-w-0 border-b border-r border-border p-0.5">
              {onOccupiedClick ? <button type="button" disabled={disabled} onClick={() => onOccupiedClick(occupied.id)} aria-label={label}
                className={`block h-full w-full rounded-control border border-current/30 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${blockStyle}`} />
                : <div aria-label={label} className={`h-full rounded-control border border-current/30 ${blockStyle}`} />}
            </div>;
          }
          const cell = cells[row];
          const selected = selection?.courtId === court.id && row >= selection.startRow && row < selection.endRow;
          const selectable = cell === "available" && (cells[row - 1] === "available" || cells[row + 1] === "available");
          const label = cell === "available" ? "Available" : cell === "booked" ? "Booked" : cell === "past" ? "Past" : "Closed";
          const accessibleLabel = `${court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${label}${selected ? ", selected" : ""}`;
          return <div key={minute} role="cell" style={{ gridColumn: row + 2 }} className={`min-w-0 border-b ${selected ? "border-primary" : "border-border"}`}>
            {selectable ? <button type="button" disabled={disabled} aria-label={accessibleLabel} aria-pressed={selected}
              onClick={() => onChoose(court.id, cells, row)}
              className={`block h-full w-full border-r focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${selected ? "border-primary bg-primary text-primary-foreground" : `border-border ${styles[cell]}`}`} />
              : <div aria-label={accessibleLabel} className={`h-full border-r border-border ${styles[cell]}`} />}
          </div>;
        });
      }} />
  </>;
}
