"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { BookingContact } from "@/lib/bookings/domain";
import type { CourtDay, CalendarCellState } from "@/lib/courts/calendar";
import { selectCalendarCell, type CalendarSelection } from "@/lib/courts/interval-selection";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { BookingConfirmation, BookingSummary, type BookingSummaryDetails } from "./booking-confirmation";

const cellStyles = {
  available: "border-success bg-success-background text-primary",
  booked: "border-danger bg-danger-background text-danger",
  closed: "border-border bg-background text-muted-foreground",
  unavailable: "border-warning bg-warning-background text-foreground",
  past: "border-muted-foreground bg-surface-muted text-muted-foreground",
} as const;
const cellLabels = { booked: "Booked", closed: "Closed", unavailable: "No pricing", past: "Past" } as const;

const emptyContact: BookingContact = { customerName: "", customerEmail: "", customerPhone: "" };

export function BookingCalendar({ day, date, locationName, currency, initialContact = emptyContact }: {
  day: { times: number[]; courts: CourtDay[] }; date: string; locationName: string; currency: LocationCurrency;
  initialContact?: BookingContact;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<CalendarSelection | null>(null);
  const [contact, setContact] = useState(initialContact);
  const [confirming, setConfirming] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [confirmed, setConfirmed] = useState<BookingSummaryDetails | null>(null);
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  const selectedCourt = day.courts.find((item) => item.court.id === selection?.courtId);
  const details: BookingSummaryDetails | null = selection && selectedCourt ? {
    locationName, courtName: selectedCourt.court.name, date,
    startMinute: selection.startMinute, endMinute: selection.endMinute,
    durationMinutes: selection.durationMinutes, priceMinor: selection.priceMinor, currency,
  } : null;
  if (confirmed) return <section aria-label="Booking confirmed" className="mt-5 max-w-lg rounded-card border border-success bg-success-background p-5">
    <h2 className="font-heading text-xl font-semibold text-primary">Booking confirmed</h2>
    <div className="mt-4"><BookingSummary details={confirmed} /></div>
    <button type="button" onClick={() => setConfirmed(null)} className="mt-4 min-h-10 rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground">Book another court</button>
  </section>;
  return <>
    {availabilityError && <p role="alert" className="mt-4 rounded-control bg-danger-background px-3 py-2 text-sm text-danger">{availabilityError}</p>}
    {day.times.length === 0 ? <p className="mt-5 rounded-card border border-border bg-surface p-5 text-muted-foreground">
      {locationName} is closed on {dateLabel}.
    </p> : <>
      <p className="mt-3 text-xs text-muted-foreground">Prices in {currency}/hour. Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust. This does not reserve a court.</p>
      <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {day.courts.map((courtDay) => <CourtTimetable key={courtDay.court.id} courtDay={courtDay} times={day.times}
          date={date} selection={selection?.courtId === courtDay.court.id ? selection : null}
          onSelect={(rowIndex) => { setAvailabilityError(""); setSelection((current) => selectCalendarCell({ courtId: courtDay.court.id,
            times: day.times, cells: courtDay.cells, hourlyPrices: courtDay.hourlyPrices }, current, rowIndex)); }} />)}
      </div>
    </>}
    {selection && selectedCourt && <section aria-label="Selected interval" aria-live="polite" className="mt-4 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold text-primary">Your selected time</h2>
          <p className="mt-1 text-sm text-muted-foreground">{locationName} · {selectedCourt.court.name} · {dateLabel}</p>
          <p className="mt-1 font-semibold tabular-nums text-foreground">{minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.durationMinutes} min</p>
          <p className="mt-1 text-sm text-foreground">Total: <strong>{formatMoney(selection.priceMinor, currency)}</strong></p>
        </div>
        <button type="button" onClick={() => setSelection(null)} className="min-h-9 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary">Clear selection</button>
      </div>
    </section>}
    {day.times.length > 0 && <button type="button" disabled={!details} onClick={() => setConfirming(true)}
      className="mt-3 min-h-10 rounded-control bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50">Continue</button>}
    {confirming && selection && details && <BookingConfirmation selection={selection} details={details} contact={contact}
      onContactChange={setContact} onBack={() => setConfirming(false)}
      onConfirmed={(totalAmountMinor, confirmedCurrency) => {
        setConfirmed({ ...details, priceMinor: totalAmountMinor, currency: confirmedCurrency });
        setConfirming(false); setSelection(null); router.refresh();
      }}
      onUnavailable={(message) => { setConfirming(false); setSelection(null); setAvailabilityError(message); router.refresh(); }} />}
  </>;
}

function CourtTimetable({ courtDay, times, date, selection, onSelect }: {
  courtDay: CourtDay; times: number[]; date: string; selection: CalendarSelection | null;
  onSelect: (rowIndex: number) => void;
}) {
  return <section className="min-w-0 overflow-hidden rounded-card border border-border bg-surface" aria-label={`${courtDay.court.name} timetable`}>
    <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
      <h2 className="font-heading text-base font-semibold text-primary">{courtDay.court.name}</h2>
      <span className="text-xs text-muted-foreground">{courtDay.stateLabel}</span>
    </header>
    <table className="w-full table-fixed border-collapse text-xs leading-none">
      <thead><tr><th scope="col" className="w-16 border-b border-r border-border px-2 py-1 text-left text-muted-foreground">Time</th>
        <th scope="col" className="border-b border-border px-2 py-1 text-left text-muted-foreground">{date}</th></tr></thead>
      <tbody>{times.map((minute, rowIndex) => {
        const state: CalendarCellState = courtDay.cells[rowIndex];
        const price = courtDay.hourlyPrices[rowIndex];
        const selected = selection && rowIndex >= selection.startRowIndex && rowIndex < selection.endRowIndex;
        const selectable = state === "available" && (courtDay.cells[rowIndex - 1] === "available" || courtDay.cells[rowIndex + 1] === "available");
        const label = state === "available" ? `${price! / 100}/h` : cellLabels[state];
        return <tr key={minute}>
          <th scope="row" className="border-b border-r border-border px-2 py-0.5 text-left font-medium tabular-nums text-primary">{minuteToTime(minute)}</th>
          <td className="border-b border-border p-0">
            {selectable ? <button type="button" aria-label={`${courtDay.court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${label}${selected ? ", selected" : ""}`}
              onClick={() => onSelect(rowIndex)}
              className={`block h-5 w-full border-l-2 px-2 text-left font-medium tabular-nums focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-accent ${selected ? "border-primary bg-primary text-primary-foreground" : cellStyles[state]}`}>
              {label}
            </button> : <div className={`flex h-5 items-center border-l-2 px-2 tabular-nums ${cellStyles[state]}`}>{label}</div>}
          </td>
        </tr>;
      })}</tbody>
    </table>
  </section>;
}
