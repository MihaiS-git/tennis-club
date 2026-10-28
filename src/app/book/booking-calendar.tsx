"use client";

import { clearCoachingFiltersEvent } from "./calendar-controls";
import type { CoachingSelection } from "./coaching-selection";
import { toast } from "sonner";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { TimelineLegend } from "@/components/court-timeline-grid";
import { Button } from "@/components/button";
import { BookingTimetable, lessonStartOffers, lessonTimetableDay, lessonTimetableLabels, lessonTimetableCellStyles, type LessonOffer } from "@/components/booking-timetable";
import { BookingCancellationTerms } from "@/components/booking-cancellation-terms";
import { startAnotherBookingEvent } from "@/components/book-court-link";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { CalendarX2, CheckCircle2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { minuteToTime } from "@/lib/courts/local-time";
import type { PaymentMethod } from "@/lib/payments/domain";
import type { BookingContact } from "@/lib/bookings/domain";
import type { CourtDay } from "@/lib/courts/calendar";
import { selectCalendarCell, type CalendarSelection } from "@/lib/courts/interval-selection";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/currency";
import { BookingSummary, type BookingSummaryDetails } from "./booking-summary";
import { LoadingStatus } from "@/components/loading-status";

// The checkout dialog, its contact validation and payment step load only once
// a visitor has selected an interval; see the preload below.
const BookingConfirmation = dynamic(() => import("./booking-confirmation").then((module) => module.BookingConfirmation),
  { loading: () => <LoadingStatus label="Opening booking confirmation…" className="mt-3" /> });


const emptyContact: BookingContact = { customerName: "", customerEmail: "", customerPhone: "" };

// Keep contact edits while changing lesson preferences; reset the interval and review.
export function BookingCalendar(props: Omit<Parameters<typeof BookingCalendarContent>[0], "contact" | "setContact">) {
  const [contact, setContact] = useState<BookingContact | null>(null);
  const context = `${props.coaching?.programId ?? "court"}:${props.coaching?.coachId ?? ""}:${props.coaching?.durationMinutes ?? ""}:${props.coaching?.participantCount ?? ""}`;
  return <BookingCalendarContent key={context} {...props} contact={contact} setContact={setContact} />;
}

function BookingCalendarContent({ day, date, locationName, currency, initialContact = emptyContact, authenticated = false, cancellationNoticeMinutes, timezone, allowPayAtClub = false, onlinePaymentAvailable = false, coaching, contact, setContact }: {
  contact: BookingContact | null; setContact: (value: BookingContact | null | ((current: BookingContact | null) => BookingContact | null)) => void;
  coaching?: CoachingSelection;
  day: { times: number[]; courts: CourtDay[] }; date: string; locationName: string; currency: LocationCurrency;
  onlinePaymentAvailable?: boolean; allowPayAtClub?: boolean; initialContact?: BookingContact; authenticated?: boolean; cancellationNoticeMinutes: number; timezone: string;
}) {
  const router = useRouter();
  const lessonOffers = useMemo(() => coaching ? lessonStartOffers(day, coaching) : new Map<string, LessonOffer>(), [coaching, day]);
  const visibleDay = useMemo(() => !coaching ? day : lessonTimetableDay(day, lessonOffers), [day, coaching, lessonOffers]);
  const contentRef = useRef<HTMLDivElement>(null);
  const actionBarRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<(CalendarSelection & { coachingQuote?: BookingSummaryDetails["coaching"] }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [committed, setCommitted] = useState<(BookingSummaryDetails & { paymentMethod: PaymentMethod; cancellationPolicy: ConfirmedCancellationPolicy | null }) | null>(null);
  // Next.js preserves route state in React Activity when navigating away.
  // Activity disconnects effects while hidden, so discard only the completed
  // workflow on departure. Refreshing this active checkout keeps confirmation.
  useLayoutEffect(() => () => { setCommitted(null); }, []);
  useEffect(() => {
    // Only a server-confirmed booking may be cleared by navbar re-selection.
    // Incomplete checkout, verification and recovery retain their state.
    if (!committed) return;
    const startAnotherBooking = () => setCommitted(null);
    window.addEventListener(startAnotherBookingEvent, startAnotherBooking);
    return () => window.removeEventListener(startAnotherBookingEvent, startAnotherBooking);
  }, [committed]);
  useEffect(() => {
    if (!coaching) return;
    const clearFilters = (event: Event) => {
      if (confirming) { event.preventDefault(); return; }
      setSelection(null);
      setCommitted(null);
    };
    window.addEventListener(clearCoachingFiltersEvent, clearFilters);
    return () => window.removeEventListener(clearCoachingFiltersEvent, clearFilters);
  }, [coaching, confirming]);
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
  useEffect(() => {
    if (hasSelection) void import("./booking-confirmation");
  }, [hasSelection]);
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  const selectedCourt = day.courts.find((item) => item.court.id === selection?.courtId);
  const details: BookingSummaryDetails | null = selection && selectedCourt ? {
    locationName, courtName: selectedCourt.court.name, date,
    startMinute: selection.startMinute, endMinute: selection.endMinute,
    durationMinutes: selection.durationMinutes, priceMinor: selection.priceMinor, currency,
    // Retain the chosen offer across action revalidation: our newly held row
    // disappears from public offers while its existing checkout stays mounted.
    ...(selection.coachingQuote ? { coaching: selection.coachingQuote } : {}),
  } : null;
  if (committed) return <section aria-label="Booking confirmed" className="mt-5 max-w-xl rounded-card border border-border border-t-4 border-t-success bg-surface p-5 shadow-card sm:p-6">
    <CheckCircle2 aria-hidden className="mb-3 size-9 text-success" />
    <h2 className="font-heading text-2xl font-semibold text-primary">Booking confirmed</h2>
    <p className="mt-2 text-sm text-muted-foreground">{coaching ? "Your coach and court are booked. " : <>Your court is booked. A confirmation email will be sent to {contact?.customerEmail}. </>} {committed.paymentMethod === "pay_at_club" ? "Payment is due at the club." : "Online payment received."}</p>
    <div className="mt-4"><BookingSummary details={committed} /></div>
    <div>{committed.cancellationPolicy && <BookingCancellationTerms noticeMinutes={committed.cancellationPolicy.noticeMinutes} cutoff={committed.cancellationPolicy.cutoff} timezone={timezone} guest={!authenticated} />}</div>
    <div className="mt-5 flex flex-wrap gap-2">
      {authenticated && <Link href="/my-activity/bookings" className="inline-flex min-h-11 items-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:min-h-10">View my bookings</Link>}
      <Button type="button" variant={authenticated ? "secondary" : "primary"} fullWidth={false} className="max-sm:min-h-11" onClick={() => setCommitted(null)}>{coaching ? "Book another lesson" : "Book another court"}</Button>
    </div>
  </section>;
  return <div ref={contentRef} className="relative min-w-0" onFocusCapture={(event) => {
    const bar = actionBarRef.current;
    if (!bar || !(event.target instanceof HTMLButtonElement) || !event.target.closest('[role="table"]')) return;
    const obscuredHeight = event.target.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
    if (obscuredHeight > 0) window.scrollBy({ top: obscuredHeight + 8 });
  }}>
    {day.times.length === 0 ? <div className="mt-4 flex items-center gap-3 rounded-card border border-border bg-surface p-5 text-muted-foreground">
      <CalendarX2 aria-hidden className="size-5 shrink-0 text-accent" /><p>{locationName} is closed on {dateLabel}.</p>
    </div> : <>
      <TimelineLegend cells={visibleDay.courts.flatMap((courtDay) => courtDay.cells)} labels={coaching ? lessonTimetableLabels : undefined} cellStyles={coaching ? lessonTimetableCellStyles : undefined}>
        {coaching ? coaching.durationMinutes
          ? `Select a lesson start for the full ${coaching.durationMinutes} minutes. Pale terracotta cells cannot start a full lesson; darker terracotta cells are occupied courts. Your coach and court are reserved only when checkout starts.`
          : "Choose your lesson details above to see available lesson starts."
          : "Select a half-hour cell to start a one-hour interval, then click adjacent cells to adjust. This does not reserve a court."}
      </TimelineLegend>
      <BookingTimetable lesson={coaching} lessonOffers={lessonOffers} day={visibleDay} date={date} timezone={timezone} currency={currency} selection={selection} onSelect={(courtDay, rowIndex) => {
        if (coaching) {
          const offer = lessonOffers.get(`${courtDay.court.id}:${day.times[rowIndex]}`);
          if (offer) setSelection(current => current?.courtId === courtDay.court.id && current.startRowIndex === rowIndex ? null : {
            courtId: courtDay.court.id, startMinute: day.times[rowIndex], endMinute: day.times[rowIndex] + coaching.durationMinutes,
            durationMinutes: coaching.durationMinutes, priceMinor: offer.totalAmountMinor,
            startRowIndex: rowIndex, endRowIndex: rowIndex + coaching.durationMinutes / 30,
            coachingQuote: { participantCount: coaching.participantCount, programName: coaching.programName, coachName: coaching.coachName,
              courtRentalIncluded: coaching.courtRentalIncluded, coachingAmountMinor: offer.coachingAmountMinor,
              courtAmountMinor: offer.courtAmountMinor } });
          return;
        }
        setSelection((current) => selectCalendarCell({ courtId: courtDay.court.id,
          times: day.times, cells: courtDay.cells, hourlyPrices: courtDay.hourlyPrices }, current, rowIndex));
      }} />
    </>}
    {selection && selectedCourt && <section ref={actionBarRef} aria-label="Selected interval" aria-live="polite" className="sticky bottom-0 z-30 mt-3 rounded-card border border-border border-t-primary/40 bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-floating sm:p-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-start justify-between gap-4 sm:justify-start sm:gap-8">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Your selected time</h2>
            <p className="mt-1 font-heading text-lg font-semibold leading-tight tabular-nums text-primary sm:text-xl">{minuteToTime(selection.startMinute)}–{minuteToTime(selection.endMinute)} · {selection.durationMinutes} min</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{locationName} · {selectedCourt.court.name} · {dateLabel}</p>
            {details?.coaching && <p className="mt-1 text-sm text-muted-foreground">{details.coaching.programName} · {details.coaching.participantCount} {details.coaching.participantCount === 1 ? "player" : "players"} · {details.coaching.coachName}<br />
              Coaching: {formatMoney(details.coaching.coachingAmountMinor, currency)} · Court: {details.coaching.courtRentalIncluded ? "included" : formatMoney(details.coaching.courtAmountMinor, currency)}</p>}
          </div>
          <p className="shrink-0 text-right text-xs font-semibold text-muted-foreground sm:text-left">Total: <strong className="block text-lg tabular-nums text-primary sm:text-xl">{formatMoney(selection.priceMinor, currency)}</strong></p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="gap-1.5 max-sm:min-h-11" onClick={() => setSelection(null)}><X aria-hidden className="size-4" />Clear selection</Button>
          <Button type="button" fullWidth={false} className="flex-1 max-sm:min-h-11 sm:flex-none" onClick={() => { setContact((current) => current ?? initialContact); setConfirming(true); }}>Continue</Button>
        </div>
      </div>
    </section>}
    {confirming && selection && details && contact && <BookingConfirmation coaching={coaching} authenticated={authenticated} onlinePaymentAvailable={onlinePaymentAvailable} allowPayAtClub={allowPayAtClub} cancellationNoticeMinutes={cancellationNoticeMinutes} timezone={timezone} selection={selection} details={details} contact={contact}
      onContactChange={setContact} onBack={() => setConfirming(false)}
      onAbandoned={() => { setConfirming(false); setSelection(null); router.refresh(); }}
      onCommitted={(totalAmountMinor, confirmedCurrency, cancellationPolicy, paymentMethod) => {
        setCommitted({ ...details, paymentMethod, priceMinor: totalAmountMinor, currency: confirmedCurrency, cancellationPolicy });
        setConfirming(false); setSelection(null); router.refresh();
      }}
      onUnavailable={(message) => { setConfirming(false); setSelection(null); toast.warning(message); router.refresh(); }} />}
  </div>;
}
