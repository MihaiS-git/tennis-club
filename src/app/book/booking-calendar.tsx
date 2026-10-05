"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CourtTimelineGrid } from "@/components/court-timeline-grid";
import { BookingCancellationTerms } from "@/components/booking-cancellation-terms";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { PaymentMethod } from "@/lib/payments/domain";
import type { BookingContact } from "@/lib/bookings/domain";
import type { CourtDay } from "@/lib/courts/calendar";
import { selectCalendarCell, type CalendarSelection } from "@/lib/courts/interval-selection";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
import { BookingConfirmation, BookingSummary, type BookingSummaryDetails } from "./booking-confirmation";

const cellStyles = {
  available: "border-success bg-success-background text-primary",
  booked: "border-danger bg-danger-background text-danger",
  closed: "border-danger bg-danger-background text-danger",
  unavailable: "border-danger bg-danger-background text-danger",
  past: "border-danger bg-danger-background text-danger",
} as const;
const cellLabels = { booked: "Booked", closed: "Closed", unavailable: "No pricing", past: "Past" } as const;

const emptyContact: BookingContact = { customerName: "", customerEmail: "", customerPhone: "" };

export function BookingCalendar({ day, date, locationName, currency, initialContact = emptyContact, authenticated = false, cancellationNoticeMinutes, timezone, allowPayAtClub = false, onlinePaymentAvailable = false }: {
  day: { times: number[]; courts: CourtDay[] }; date: string; locationName: string; currency: LocationCurrency;
  onlinePaymentAvailable?: boolean; allowPayAtClub?: boolean; initialContact?: BookingContact; authenticated?: boolean; cancellationNoticeMinutes: number; timezone: string;
}) {
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);
  const [contact, setContact] = useState(initialContact);
  const [confirming, setConfirming] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [committed, setCommitted] = useState<(BookingSummaryDetails & { paymentMethod: PaymentMethod; cancellationPolicy: ConfirmedCancellationPolicy | null }) | null>(null);
  const hasSelection = selection !== null;
  useEffect(() => {
    const content = contentRef.current;
    const bar = actionBarRef.current;
    const timetable = content?.querySelector<HTMLElement>('[role="table"]');
    if (!bar || !timetable) return;
    // The bar reserves its own height in normal flow. While it sticks, clip
    // the schedule at the bar's edge so no cells are painted or hit-tested beneath it.
    const update = () => {
      const hiddenHeight = Math.max(0, timetable.getBoundingClientRect().bottom - bar.getBoundingClientRect().top);
      timetable.style.clipPath = hiddenHeight ? `inset(0 0 ${hiddenHeight}px 0)` : "";
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(bar);
    observer?.observe(timetable);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
      timetable.style.clipPath = "";
    };
  }, [hasSelection]);
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  const selectedCourt = day.courts.find((item) => item.court.id === selection?.courtId);
  const details: BookingSummaryDetails | null = selection && selectedCourt ? {
    locationName, courtName: selectedCourt.court.name, date,
    startMinute: selection.startMinute, endMinute: selection.endMinute,
    durationMinutes: selection.durationMinutes, priceMinor: selection.priceMinor, currency,
  } : null;
  if (committed) return <section aria-label="Booking confirmed" className="mt-5 max-w-xl rounded-card border border-success bg-surface p-5 sm:p-6">
    <CheckCircle2 aria-hidden className="mb-3 size-9 text-success" />
    <h2 className="font-heading text-2xl font-semibold text-primary">Booking confirmed</h2>
    <p className="mt-2 text-sm text-muted-foreground">Your court is booked. A confirmation email will be sent to {contact.customerEmail}. {committed.paymentMethod === "pay_at_club" ? "Payment is due at the club." : "Online payment received."}</p>
    <div className="mt-4"><BookingSummary details={committed} /></div>
    <div>{committed.cancellationPolicy && <BookingCancellationTerms noticeMinutes={committed.cancellationPolicy.noticeMinutes} cutoff={committed.cancellationPolicy.cutoff} timezone={timezone} />}</div>
    <div className="mt-5 flex flex-wrap gap-2">
      {authenticated && <Link href="/my-activity/bookings" className="inline-flex min-h-10 items-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground">View my bookings</Link>}
      <button type="button" onClick={() => setCommitted(null)} className={`min-h-10 rounded-control border px-4 text-sm font-semibold ${authenticated ? "border-border-strong text-primary" : "border-primary bg-primary text-primary-foreground"}`}>Book another court</button>
    </div>
  </section>;
  return <div ref={contentRef} className="relative min-w-0" onFocusCapture={(event) => {
    const bar = actionBarRef.current;
    if (!bar || !(event.target instanceof HTMLButtonElement) || !event.target.closest('[role="table"]')) return;
    const obscuredHeight = event.target.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
    if (obscuredHeight > 0) window.scrollBy({ top: obscuredHeight + 8 });
  }}>
    {availabilityError && <p role="alert" className="mt-4 rounded-control bg-danger-background px-3 py-2 text-sm text-danger">{availabilityError}</p>}
    {day.times.length === 0 ? <p className="mt-5 rounded-card border border-border bg-surface p-5 text-muted-foreground">
      {locationName} is closed on {dateLabel}.
    </p> : <>
      <p className="mt-3 text-xs text-muted-foreground">Prices in {currency}/hour. Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust. This does not reserve a court.</p>
      <BookingTimetable day={day} date={date} timezone={timezone} selection={selection} onSelect={(courtDay, rowIndex) => {
        setAvailabilityError("");
        setSelection((current) => selectCalendarCell({ courtId: courtDay.court.id,
          times: day.times, cells: courtDay.cells, hourlyPrices: courtDay.hourlyPrices }, current, rowIndex));
      }} />
    </>}
    {selection && selectedCourt && <section ref={actionBarRef} aria-label="Selected interval" aria-live="polite" className="sticky bottom-0 z-30 mt-3 rounded-card border border-border bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-floating sm:p-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold text-primary">Your selected time</h2>
          <p className="mt-1 text-sm text-muted-foreground">{locationName} · {selectedCourt.court.name} · {dateLabel}</p>
          <p className="mt-1 font-semibold tabular-nums text-foreground">{minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.durationMinutes} min</p>
          <p className="mt-1 text-sm text-foreground">Total: <strong>{formatMoney(selection.priceMinor, currency)}</strong></p>
        </div>
        <div className="flex gap-2"><button type="button" onClick={() => setSelection(null)} className="min-h-9 rounded-control border border-border-strong px-3 text-sm font-semibold text-primary">Clear selection</button>
          <button type="button" onClick={() => setConfirming(true)} className="min-h-10 rounded-control bg-primary px-5 text-sm font-semibold text-primary-foreground">Continue</button></div>
      </div>
    </section>}
    {confirming && selection && details && <BookingConfirmation onlinePaymentAvailable={onlinePaymentAvailable} allowPayAtClub={allowPayAtClub} cancellationNoticeMinutes={cancellationNoticeMinutes} timezone={timezone} selection={selection} details={details} contact={contact}
      onContactChange={setContact} onBack={() => setConfirming(false)}
      onAbandoned={() => { setConfirming(false); setSelection(null); setAvailabilityError(""); router.refresh(); }}
      onCommitted={(totalAmountMinor, confirmedCurrency, cancellationPolicy, paymentMethod) => {
        setCommitted({ ...details, paymentMethod, priceMinor: totalAmountMinor, currency: confirmedCurrency, cancellationPolicy });
        setConfirming(false); setSelection(null); router.refresh();
      }}
      onUnavailable={(message) => { setConfirming(false); setSelection(null); setAvailabilityError(message); router.refresh(); }} />}
  </div>;
}

function BookingTimetable({ day, date, timezone, selection, onSelect }: {
  day: { times: number[]; courts: CourtDay[] }; date: string; timezone: string; selection: CalendarSelection | null;
  onSelect: (courtDay: CourtDay, rowIndex: number) => void;
}) {
  const firstActionableMinute = day.times.find((_, index) => day.courts.some(({ cells }) => cells[index] === "available" && (cells[index - 1] === "available" || cells[index + 1] === "available")));
  return <CourtTimelineGrid times={day.times} rows={day.courts} date={date} timezone={timezone}
    selectedStartMinute={selection?.startMinute} selectedEndMinute={selection?.endMinute} firstActionableMinute={firstActionableMinute}
    renderCourtContext={(row) => row.stateLabel}
    renderCells={(courtDay) => day.times.map((minute, rowIndex) => {
      const state = courtDay.cells[rowIndex];
      const price = courtDay.hourlyPrices[rowIndex];
      const selected = selection?.courtId === courtDay.court.id && rowIndex >= selection.startRowIndex && rowIndex < selection.endRowIndex;
      const selectable = state === "available" && (courtDay.cells[rowIndex - 1] === "available" || courtDay.cells[rowIndex + 1] === "available");
      const label = state === "available" ? `${price! / 100}/h` : cellLabels[state];
      const accessibleLabel = `${courtDay.court.name} ${date} ${minuteToTime(minute)}–${minuteToTime(minute + 30)}, ${label}${selected ? ", selected" : ""}`;
      return <div key={minute} role="cell" className={`min-w-0 border-b ${selected ? "border-primary" : "border-border"}`}>
        {selectable ? <button type="button" aria-pressed={selected} aria-label={accessibleLabel}
          onClick={() => onSelect(courtDay, rowIndex)}
          className={`h-full w-full border-r px-0.5 text-center text-[length:var(--timeline-cell-font-size)] font-medium tabular-nums focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${selected ? "border-primary bg-primary text-primary-foreground" : `border-border ${cellStyles[state]}`}`}>
          {label}
        </button> : <div aria-label={accessibleLabel} className={`flex h-full items-center justify-center border-r border-border px-0.5 text-[length:var(--timeline-cell-font-size)] tabular-nums ${cellStyles[state]}`}>{state === "available" ? label : null}</div>}
      </div>;
    })} />;
}
