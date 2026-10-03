"use client";

import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { ReservationCell, ReservationSelection } from "@/lib/reservations/domain";

export type ReservationTimetableDay = {
  times: number[];
  courts: { court: { id: string; name: string }; cells: ReservationCell[] }[];
};
export type OccupiedInterval = { id: string; courtId: string; startsAtMinute: number; endsAtMinute: number; label: string };

const styles = {
  available: "border-success bg-success-background text-primary",
  booked: "border-danger bg-danger-background text-danger",
  closed: "border-border bg-background text-muted-foreground",
  past: "border-muted-foreground bg-surface-muted text-muted-foreground",
} as const;

export function ReservationTimetable({ day, date, selection, onChoose, occupiedIntervals = [], onOccupiedClick, disabled = false }: {
  day: ReservationTimetableDay; date: string; selection: ReservationSelection | null;
  onChoose: (courtId: string, cells: ReservationCell[], row: number) => void;
  occupiedIntervals?: OccupiedInterval[]; onOccupiedClick?: (id: string) => void; disabled?: boolean;
}) {
  if (day.times.length === 0) return <p className="mt-4 text-sm text-muted-foreground">Closed on this date.</p>;
  return <>
    <p className="mt-3 text-xs text-muted-foreground">Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust.</p>
    <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {day.courts.map(({ court, cells }) => <section key={court.id} aria-label={`${court.name} timetable`} className="min-w-0 overflow-hidden rounded-card border border-border bg-surface">
        <h2 className="border-b border-border px-3 py-2 font-heading text-base font-semibold text-primary">{court.name}</h2>
        <table className="w-full table-fixed border-collapse text-xs leading-none">
          <thead><tr><th scope="col" className="w-16 border-b border-r border-border px-2 py-1 text-left text-muted-foreground">Time</th>
            <th scope="col" className="border-b border-border px-2 py-1 text-left text-muted-foreground">{date}</th></tr></thead>
          <tbody>{day.times.map((minute, row) => {
            const cell = cells[row];
            const selected = selection?.courtId === court.id && row >= selection.startRow && row < selection.endRow;
            const selectable = cell === "available" && (cells[row - 1] === "available" || cells[row + 1] === "available");
            const label = cell === "available" ? "Available" : cell === "booked" ? "Booked" : cell === "past" ? "Past" : "Closed";
            const occupied = cell === "booked" ? occupiedIntervals.find((item) => item.courtId === court.id
              && item.startsAtMinute < minute + 30 && minute < item.endsAtMinute) : undefined;
            const occupiedLabel = occupied ? (minute <= occupied.startsAtMinute ? occupied.label : "↳") : label;
            return <tr key={minute}><th scope="row" className="border-b border-r border-border px-2 py-0.5 text-left font-medium tabular-nums text-primary">{minuteToTime(minute)}</th>
              <td className="border-b border-border p-0">{selectable ? <button type="button" disabled={disabled}
                aria-label={`${court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${label}${selected ? ", selected" : ""}`}
                aria-pressed={selected}
                onClick={() => onChoose(court.id, cells, row)}
                className={`block h-5 w-full border-l-2 px-2 text-left font-medium focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-accent ${selected ? "border-primary bg-primary text-primary-foreground" : styles[cell]}`}>{label}</button>
                : occupied && onOccupiedClick ? <button type="button" disabled={disabled} onClick={() => onOccupiedClick(occupied.id)}
                    aria-label={`${court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${occupied.label}`}
                    className={`block h-5 w-full truncate border-l-2 px-2 text-left font-medium focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-accent ${styles.booked}`}>{occupiedLabel}</button>
                  : <div className={`flex h-5 items-center border-l-2 px-2 ${styles[cell]}`}>{label}</div>}</td></tr>;
          })}</tbody>
        </table>
      </section>)}
    </div>
  </>;
}
