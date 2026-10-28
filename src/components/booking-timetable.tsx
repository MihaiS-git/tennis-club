"use client";

import { CourtTimelineGrid, timelineCellLabels, timelineCellStyles, timelineSelectedStyle, type TimelineCellState } from "@/components/court-timeline-grid";
import { minuteToTime } from "@/lib/courts/local-time";
import type { PublicLessonStart } from "@/lib/coaching/lesson-availability";
import type { CalendarSelection } from "@/lib/courts/interval-selection";
import { formatHourlyRate } from "@/lib/courts/price-bands";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/currency";

export type BookingTimetableRow = {
  court: { id: string; name: string }; cells: TimelineCellState[];
  hourlyPrices?: (number | null)[]; rates?: (number | null)[]; stateLabel?: string;
};
export type BookingTimetableDay<Row extends BookingTimetableRow = BookingTimetableRow> = { times: number[]; courts: Row[] };
export type LessonOffer = { coachingAmountMinor: number; courtAmountMinor: number; totalAmountMinor: number };
type TimetableSelection = Pick<CalendarSelection, "courtId" | "startMinute" | "endMinute" | "startRowIndex" | "endRowIndex">;

export const lessonTimetableLabels = { unavailable: "No lesson start" } as const;
export const lessonTimetableCellStyles = { ...timelineCellStyles, unavailable: "bg-clay-100 text-foreground" };

// Server-quoted lesson starts whose full length is free on that court, keyed by court and start.
export function lessonStartOffers(day: BookingTimetableDay, lesson: { durationMinutes: number; starts: PublicLessonStart[] }) {
  const offers = new Map<string, LessonOffer>();
  for (const start of lesson.starts) for (const court of start.courts) {
    const row = day.courts.find(item => item.court.id === court.id);
    const first = day.times.indexOf(start.startMinute);
    const length = lesson.durationMinutes / 30;
    if (row && first >= 0 && length >= 2 && start.endMinute - start.startMinute === lesson.durationMinutes
      && Array.from({ length }, (_, offset) => row.cells[first + offset]).every(cell => cell === "available"))
      offers.set(`${court.id}:${start.startMinute}`, court);
  }
  return offers;
}

// Free cells that cannot start a full lesson are shown as unavailable starts.
export function lessonTimetableDay<Row extends BookingTimetableRow>(day: BookingTimetableDay<Row>, offers: Map<string, LessonOffer>): BookingTimetableDay<Row> {
  return { ...day, courts: day.courts.map(row => ({ ...row,
    cells: row.cells.map((state, index) => state === "available" && !offers.has(`${row.court.id}:${day.times[index]}`)
      ? "unavailable" as const : state),
  })) };
}

export function BookingTimetable<Row extends BookingTimetableRow>({ day, date, timezone, currency, selection, onSelect, lesson, lessonOffers, disabled = false }: {
  lesson?: { durationMinutes: number };
  lessonOffers: Map<string, { totalAmountMinor: number }>;
  day: BookingTimetableDay<Row>; date: string; timezone: string; currency: LocationCurrency; selection: TimetableSelection | null;
  onSelect: (courtDay: Row, rowIndex: number) => void; disabled?: boolean;
}) {
  const cellStyles = lesson ? lessonTimetableCellStyles : timelineCellStyles;
  const firstActionableMinute = day.times.find((_, index) => day.courts.some(({ cells }) => cells[index] === "available" && (lesson || cells[index - 1] === "available" || cells[index + 1] === "available")));
  return <CourtTimelineGrid times={day.times} rows={day.courts} date={date} timezone={timezone}
    selectedStartMinute={selection?.startMinute} selectedEndMinute={selection?.endMinute} firstActionableMinute={firstActionableMinute}
    renderCourtContext={(row) => row.stateLabel} priceRates={lesson ? undefined : (row) => row.rates} currency={currency}
    renderCells={(courtDay) => day.times.map((minute, rowIndex) => {
      const state = courtDay.cells[rowIndex];
      const price = courtDay.hourlyPrices?.[rowIndex];
      const selected = selection?.courtId === courtDay.court.id && rowIndex >= selection.startRowIndex && rowIndex < selection.endRowIndex;
      const selectable = state === "available" && (lesson || courtDay.cells[rowIndex - 1] === "available" || courtDay.cells[rowIndex + 1] === "available");
      const offer = lessonOffers.get(`${courtDay.court.id}:${minute}`);
      const label = lesson ? offer && selectable ? `${lesson.durationMinutes} min lesson, ${formatMoney(offer.totalAmountMinor, currency)} total`
        : state === "unavailable" ? lessonTimetableLabels.unavailable : timelineCellLabels[state]
        : state === "available" ? formatHourlyRate(price!, currency) : timelineCellLabels[state];
      const accessibleLabel = `${courtDay.court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + (lesson && selectable ? lesson.durationMinutes : 30))}, ${label}${selected ? ", selected" : ""}`;
      // Block buttons avoid inline baseline overflow and a scrollbar that narrows rows relative to the header.
      return <div key={minute} role="cell" className={`min-w-0 border-b ${selected ? "border-primary" : "border-border"}`}>
        {selectable ? <button type="button" disabled={disabled} aria-pressed={selected} aria-label={accessibleLabel}
          onClick={() => onSelect(courtDay, rowIndex)}
          className={`block h-full w-full border-r px-0.5 text-center text-[length:var(--timeline-cell-font-size)] font-medium tabular-nums focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${selected ? `border-primary ${timelineSelectedStyle}` : `border-border ${cellStyles[state]}`}`}>
        </button> : <div aria-label={accessibleLabel} className={`flex h-full items-center justify-center border-r border-border px-0.5 text-[length:var(--timeline-cell-font-size)] tabular-nums ${selected ? timelineSelectedStyle : cellStyles[state]}`} />}
      </div>;
    })} />;
}
