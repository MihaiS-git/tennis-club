"use client";

import { CourtTimelineGrid, TimelineLegend, timelineCellLabels, timelineCellStyles, timelineSelectedStyle } from "@/components/court-timeline-grid";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { ReservationCell, ReservationSelection } from "@/lib/reservations/domain";

export type ReservationTimetableDay = {
  times: number[];
  // Rates are present only for customer booking edits; Admin/staff reservations are free.
  courts: { court: { id: string; name: string }; cells: ReservationCell[]; rates?: (number | null)[] }[];
  currency?: string;
};
export type OccupiedInterval = { id: string; courtId: string; startsAtMinute: number; endsAtMinute: number; label: string; kind?: "booking" | "reservation" };

// Staff reservations are distinguished from customer bookings in Admin occupancy.
const reservationBlockStyle = "bg-clay-300 text-primary";

export function ReservationTimetable({ day, date, timezone, selection, onChoose, occupiedIntervals = [], onOccupiedClick, disabled = false }: {
  day: ReservationTimetableDay; date: string; timezone?: string; selection: ReservationSelection | null;
  onChoose: (courtId: string, cells: ReservationCell[], row: number) => void;
  occupiedIntervals?: OccupiedInterval[]; onOccupiedClick?: (id: string) => void; disabled?: boolean;
}) {
  if (day.times.length === 0) return <p className="mt-4 text-sm text-muted-foreground">Closed on this date.</p>;
  const firstActionableMinute = day.times.find((_, index) => day.courts.some(({ cells }) => cells[index] === "available" && (cells[index - 1] === "available" || cells[index + 1] === "available")));
  // Booked time drawn as a staff reservation block is described by that block's own legend entry.
  const legendCells = day.courts.flatMap(({ court, cells }) => cells.filter((cell, row) => cell !== "booked"
    || !occupiedIntervals.some((item) => item.kind === "reservation" && item.courtId === court.id
      && item.startsAtMinute < day.times[row] + 30 && day.times[row] < item.endsAtMinute)));
  return <>
    <TimelineLegend cells={legendCells}
      extras={occupiedIntervals.some((item) => item.kind === "reservation") ? [{ label: "Reservation", className: reservationBlockStyle }] : []}>
      Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust.
    </TimelineLegend>
    <CourtTimelineGrid times={day.times} rows={day.courts} date={date} timezone={timezone}
      selectedStartMinute={selection?.startMinute} selectedEndMinute={selection?.endMinute} firstActionableMinute={firstActionableMinute}
      priceRates={(row) => row.rates} currency={day.currency}
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
            const blockStyle = occupied.kind === "reservation" ? reservationBlockStyle : timelineCellStyles.booked;
            return <div key={`${minute}:${occupied.id}`} role="cell" aria-colspan={span} style={{ gridColumn: `${row + 2} / span ${span}` }} className="min-w-0 border-b border-r border-border p-0.5">
              {onOccupiedClick ? <button type="button" disabled={disabled} onClick={() => onOccupiedClick(occupied.id)} aria-label={label}
                className={`block h-full w-full rounded-control border border-current/30 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${blockStyle}`} />
                : <div aria-label={label} className={`h-full rounded-control border border-current/30 ${blockStyle}`} />}
            </div>;
          }
          const cell = cells[row];
          const selected = selection?.courtId === court.id && row >= selection.startRow && row < selection.endRow;
          const selectable = cell === "available" && (cells[row - 1] === "available" || cells[row + 1] === "available");
          const label = timelineCellLabels[cell];
          const accessibleLabel = `${court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${label}${selected ? ", selected" : ""}`;
          return <div key={minute} role="cell" style={{ gridColumn: row + 2 }} className={`min-w-0 border-b ${selected ? "border-primary" : "border-border"}`}>
            {selectable ? <button type="button" disabled={disabled} aria-label={accessibleLabel} aria-pressed={selected}
              onClick={() => onChoose(court.id, cells, row)}
              className={`block h-full w-full border-r focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${selected ? `border-primary ${timelineSelectedStyle}` : `border-border ${timelineCellStyles[cell]}`}`} />
              : <div aria-label={accessibleLabel} className={`h-full border-r border-border ${timelineCellStyles[cell]}`} />}
          </div>;
        });
      }} />
  </>;
}
