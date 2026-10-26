"use client";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ReservationEditForm, type ReservationEditDraft, type ReservationEditSaveResult } from "@/components/reservation-edit-form";
import type { ReservationTimetableDay } from "@/components/reservation-timetable";
import { TimelineLegend } from "@/components/court-timeline-grid";
import { BookingTimetable, lessonStartOffers, lessonTimetableDay, lessonTimetableLabels, type LessonOffer } from "@/components/booking-timetable";
import type { ReservationSelection } from "@/lib/reservations/domain";
import type { AdminBooking, InternalLocation } from "@/lib/reservations/service";
import type { BookingEditContext } from "@/lib/bookings/reschedule";
import { OnlinePayment } from "@/app/book/online-payment";
import type { BookingRescheduleResult } from "@/lib/bookings/reschedule";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { formatMoney } from "@/lib/pricing/money";
import { loadOwnBookingEditDayAction, quoteOwnBookingAction, rescheduleOwnBookingAction } from "@/app/my-activity/bookings/actions";

export type BookingEditActions = {
  load: typeof loadOwnBookingEditDayAction;
  quote: typeof quoteOwnBookingAction;
  save: typeof rescheduleOwnBookingAction;
};
const ownerActions: BookingEditActions = { load: loadOwnBookingEditDayAction, quote: quoteOwnBookingAction, save: rescheduleOwnBookingAction };

type Quote = { key: string; total: number; requiresConfirmation?: boolean };
function draftKey(draft: ReservationEditDraft) {
  return `${draft.date}/${draft.selection?.courtId}/${draft.selection?.startMinute}/${draft.selection?.endMinute}`;
}
function editInput(id: string, context: BookingEditContext, draft: ReservationEditDraft) {
  return { id, expectedUpdatedAt: context.updated_at, expectedRevisionId: context.current_revision_id,
    courtId: draft.selection?.courtId, date: draft.date, startMinute: draft.selection?.startMinute,
    endMinute: draft.selection?.endMinute };
}

type LessonTerms = NonNullable<BookingEditContext["coaching"]>;
// The edit day plus the lesson starts the server quoted for that date.
type LessonDay = ReservationTimetableDay & { lesson: LessonTerms | null };

// The /book lesson timetable: a start selects the lesson's full, fixed length.
function LessonTimetable({ day, date, timezone, currency, selection, select, disabled }: {
  day: LessonDay; date: string; timezone: string; currency: AdminBooking["currency"];
  selection: ReservationSelection | null; select: (selection: ReservationSelection | null) => void; disabled: boolean;
}) {
  const { lesson } = day;
  const offers = useMemo(() => lesson ? lessonStartOffers(day, lesson) : new Map<string, LessonOffer>(), [day, lesson]);
  if (day.times.length === 0 || !lesson) return <p className="mt-4 text-sm text-muted-foreground">No lesson starts on this date.</p>;
  const visibleDay = lessonTimetableDay(day, offers);
  const length = lesson.durationMinutes / 30;
  return <>
    <TimelineLegend cells={visibleDay.courts.flatMap((row) => row.cells)} labels={lessonTimetableLabels}>
      Select a new lesson start for the full {lesson.durationMinutes} minutes. Dotted cells cannot start a full lesson; solid cells are occupied courts.
    </TimelineLegend>
    <BookingTimetable lesson={lesson} lessonOffers={offers} day={visibleDay} date={date} timezone={timezone} currency={currency} disabled={disabled}
      selection={selection && { courtId: selection.courtId, startMinute: selection.startMinute, endMinute: selection.endMinute,
        startRowIndex: selection.startRow, endRowIndex: selection.endRow }}
      onSelect={(row, index) => {
        if (!offers.has(`${row.court.id}:${day.times[index]}`)) return;
        select(selection?.courtId === row.court.id && selection.startRow === index ? null : { courtId: row.court.id,
          startRow: index, endRow: index + length, startMinute: day.times[index], endMinute: day.times[index] + lesson.durationMinutes });
      }} />
  </>;
}

// The fixed lesson terms beside the original and proposed interval.
function LessonChange({ context, lesson, draft }: { context: BookingEditContext; lesson: LessonTerms; draft: ReservationEditDraft }) {
  const courtName = (id: string | undefined) => context.location.courts.find((c) => c.id === id)?.name ?? "Court";
  const { selection } = draft;
  const proposed = selection && (selection.courtId !== context.court_id || draft.date !== context.booking_date
    || selection.startMinute !== context.starts_at_minute) ? selection : null;
  return <section aria-label="Lesson" className="rounded-control border border-border bg-surface-muted/50 p-3 text-sm">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 [&_dd]:text-right [&_dd]:font-semibold">
      <dt className="text-muted-foreground">Location</dt><dd>{context.location.name}</dd>
      <dt className="text-muted-foreground">Court</dt><dd>{courtName(context.court_id)}</dd>
      <dt className="text-muted-foreground">Coach</dt><dd>{lesson.coach.name}</dd>
      <dt className="text-muted-foreground">Program</dt><dd>{lesson.program.name}</dd>
      <dt className="text-muted-foreground">Duration</dt><dd>{lesson.durationMinutes} min</dd>
      <dt className="text-muted-foreground">Original</dt>
      <dd>{context.booking_date} · {minuteToTime(context.starts_at_minute)}–{minuteToTime(context.ends_at_minute)} · {courtName(context.court_id)}</dd>
      <dt className="text-muted-foreground">Proposed</dt>
      <dd className="text-primary">{proposed
        ? `${draft.date} · ${minuteToTime(proposed.startMinute)}–${minuteToTime(proposed.endMinute)} · ${courtName(proposed.courtId)}`
        : <span className="font-normal text-muted-foreground">Choose a new lesson start</span>}</dd>
    </dl>
  </section>;
}

function BookingPrice({ id, context, draft, currency, quote, acknowledged, onQuote, onAcknowledge, actions, pending }: {
  pending: boolean;
  actions: BookingEditActions;
  id: string; context: BookingEditContext; draft: ReservationEditDraft; currency: AdminBooking["currency"];
  quote: Quote | null; acknowledged: boolean; onQuote: (quote: Quote | null) => void; onAcknowledge: (value: boolean) => void;
}) {
  const key = draftKey(draft);
  const courtId = draft.selection?.courtId, startMinute = draft.selection?.startMinute, endMinute = draft.selection?.endMinute;
  useEffect(() => {
    let disposed = false;
    onQuote(null);
    if (!courtId || startMinute === undefined || endMinute === undefined) return;
    let notification: string | number | undefined;
    actions.quote({ id, expectedUpdatedAt: context.updated_at,
      expectedRevisionId: context.current_revision_id, courtId, date: draft.date, startMinute, endMinute,
      save: false, expectedTotal: null, priceAcknowledged: false }).then((result) => {
      if (disposed) return;
      if (result.ok) { onQuote({ key, total: result.totalAmountMinor }); }
      else notification = toast.error(result.message);
    }).catch(() => { if (!disposed) notification = toast.error("Unable to calculate the new total. Choose the interval again."); });
    return () => { disposed = true; if (notification !== undefined) toast.dismiss(notification); };
  }, [id, context.updated_at, context.current_revision_id, courtId, draft.date, startMinute, endMinute, key, onQuote, actions]);
  const currentQuote = quote?.key === key ? quote : null;
  const increase = currentQuote ? currentQuote.total > context.total_amount_minor : false;
  return <section aria-label="Booking price" className="rounded-control border border-border bg-surface-muted/50 p-3 text-sm">
    <dl className="grid grid-cols-2 gap-3">
      <div><dt className="text-xs font-medium text-muted-foreground">Current total</dt>
        <dd className="mt-0.5 font-semibold tabular-nums text-foreground">{formatMoney(context.total_amount_minor, currency)}</dd></div>
      <div><dt className="text-xs font-medium text-muted-foreground">New total</dt>
        <dd className={currentQuote ? "mt-0.5 text-base font-semibold tabular-nums text-primary" : "mt-0.5 text-muted-foreground"}>{currentQuote ? formatMoney(currentQuote.total, currency) : draft.selection ? "Calculating booking total…" : "Choose an interval"}</dd></div>
    </dl>
    {currentQuote && currentQuote.total !== context.total_amount_minor && context.payment_method === "online" && <p className={`mt-3 rounded-control px-3 py-2 font-semibold tabular-nums ${increase ? "bg-warning-background text-foreground" : "bg-success-background text-success"}`}>
      {increase ? "Additional amount payable: " : "Eligible refund: "}
      {formatMoney(Math.abs(currentQuote.total - context.total_amount_minor), currency)}
    </p>}
    {context.refunds.map(refund => <p key={refund.id} className="mt-2 text-muted-foreground">
      Refund {formatMoney(refund.amount, currency)}: {refund.status === "succeeded" ? "completed" : refund.status === "failed" ? "could not be completed; the club will contact you" : refund.status === "voided" ? "not made; the change was abandoned" : "requested, awaiting confirmation"}
    </p>)}
    {currentQuote && (currentQuote.total !== context.total_amount_minor || currentQuote.requiresConfirmation) && <label className="mt-3 flex items-center gap-2 font-medium">
      <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => onAcknowledge(event.target.checked)} />
      I confirm the new total of {formatMoney(currentQuote.total, currency)}.
    </label>}
  </section>;
}

type BookingEditFormProps = {
  booking: Pick<AdminBooking, "id" | "booking_date" | "currency">; location?: Pick<InternalLocation, "name" | "courts">; actions?: BookingEditActions; onCancel: () => void;
  onSaved: () => Promise<void>; onPendingChange: (value: boolean) => void;
  // The unpaid modification created in this dialog, which X must dismiss.
  onAdjustment?: (id: string | null) => void;
};

export function BookingEditForm(props: BookingEditFormProps) {
  return <BookingEditSession key={`${props.booking.id}/${props.booking.booking_date}`} {...props} />;
}

function BookingEditSession({ booking, location, onCancel, onSaved, onPendingChange, onAdjustment, actions = ownerActions }: BookingEditFormProps) {
  const active = useRef(true);
  const [initial, setInitial] = useState<Awaited<ReturnType<BookingEditActions["load"]>> | null>(null);
  const context = initial?.booking;
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [adjustment, setAdjustment] = useState<Extract<BookingRescheduleResult, { ok: true }> | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  // Stable setter identity avoids restarting a quote on every render.
  const receiveQuote = useCallback((value: Quote | null) => { setQuote(value); setAcknowledged(false); }, []);
  const initialAvailability = useMemo(() => initial ? { reservationId: booking.id, date: booking.booking_date,
    day: { ...initial.day, courts: initial.booking.coaching
      ? initial.day.courts.filter(row => row.court.id === initial.booking.court_id) : initial.day.courts,
      lesson: initial.booking.coaching } } : undefined, [initial, booking.id, booking.booking_date]);
  // A lesson's starts depend on the date, so each day read carries them to its timetable.
  const loadLessonDay = useMemo(() => async (id: string, date: string) => {
    const result = await actions.load(id, date);
    return { day: { ...result.day, courts: result.booking.coaching
      ? result.day.courts.filter(row => row.court.id === result.booking.court_id) : result.day.courts,
      lesson: result.booking.coaching } };
  }, [actions]);
  useEffect(() => {
    let disposed = false;
    active.current = true;
    // Keep read progress inside its component. Sonner queues publication with a
    // timer but dismissal with animation frames; fast completion/disposal can
    // dismiss before publication and leave an infinite loading toast on screen.
    let notification: string | number | undefined;
    actions.load(booking.id, booking.booking_date).then((result) => {
      // Every Edit opens a fresh form; earlier modifications are never resumed.
      if (!disposed) setInitial(result);
    }).catch(() => { if (!disposed) {
      setError("This booking is no longer available to edit. Close and reopen its details.");
      notification = toast.error("This booking is no longer available to edit. Close and reopen its details.");
    } });
    return () => { active.current = false; disposed = true; if (notification !== undefined) toast.dismiss(notification); };
  }, [booking.id, booking.booking_date, actions]);
  if (!context) return <div className="mt-4 min-h-20 text-sm" aria-busy={!error}>
    <p role={error ? "alert" : "status"}>{error || "Loading booking…"}</p>
    <button type="button" onClick={onCancel} className="mt-3 underline">Back to details</button></div>;
  if (adjustment) return <section aria-label="Booking modification" data-booking-modification className="mx-auto mt-4 max-w-xl space-y-4 text-sm">
    <div className="rounded-control border border-border bg-surface-muted p-4">
      <h3 className="mb-3 font-heading text-base font-semibold text-primary">{adjustment.adjustmentStatus === "pending" ? "Complete your modification"
        : adjustment.adjustmentStatus === "applied" ? "Booking modification completed" : "Modification ended"}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 [&_dd]:text-right [&_dd]:font-semibold">
        <dt className="text-muted-foreground">Location</dt><dd>{context.location.name}</dd>
        {adjustment.target && <>
          <dt className="text-muted-foreground">Court</dt><dd>{context.location.courts.find(c => c.id === adjustment.target?.courtId)?.name ?? "Court"}</dd>
          <dt className="text-muted-foreground">Date</dt><dd>{adjustment.target.date}</dd>
          <dt className="text-muted-foreground">Time</dt><dd>{minuteToTime(adjustment.target.startMinute)}–{minuteToTime(adjustment.target.endMinute)}</dd>
        </>}
        <dt className="text-muted-foreground">Current total</dt><dd>{formatMoney(context.total_amount_minor, booking.currency)}</dd>
        <dt className="text-muted-foreground">{adjustment.adjustmentStatus === "applied" ? "Updated total" : "Proposed total"}</dt><dd>{formatMoney(adjustment.totalAmountMinor, booking.currency)}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3 text-primary">
        <span className="font-semibold">{adjustment.refundStatus || adjustment.totalAmountMinor < context.total_amount_minor ? "Refund amount" : "Additional amount payable"}</span>
        <strong className="text-2xl tabular-nums">{formatMoney(Math.abs(adjustment.totalAmountMinor - context.total_amount_minor), booking.currency)}</strong>
      </div>
      {adjustment.refundStatus && <dl className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <dt className="text-muted-foreground">Refund status</dt>
        <dd role="status" className={`rounded-full px-3 py-1 text-xs font-semibold ${adjustment.refundStatus === "succeeded" ? "bg-success-background text-success" : adjustment.refundStatus === "failed" ? "bg-danger-background text-danger" : "bg-warning-background text-foreground"}`}>
          {adjustment.refundStatus === "succeeded" ? "Refund completed" : adjustment.refundStatus === "failed" ? "Refund could not be completed; the club will contact you" : "Refund requested, awaiting confirmation"}
        </dd>
      </dl>}
    </div>
    {adjustment.adjustmentStatus === "pending" && adjustment.refundStatus ? <p role="status" className="text-muted-foreground">
      Your original booking remains confirmed. The change is applied automatically once the refund is confirmed.</p>
    : adjustment.adjustmentStatus === "pending" ? <>
      <p className="text-muted-foreground">Your original booking remains confirmed until payment and the change are verified.</p>
      {adjustment.checkout && adjustment.holdExpiresAt ? <OnlinePayment checkout={adjustment.checkout}
        holdExpiresAt={adjustment.holdExpiresAt} purpose="modification" confirmationMessage="Booking modification completed."
        onConfirmed={() => { if (!active.current) return; onAdjustment?.(null); void onSaved().catch(() => toast.warning("Booking modification completed. Unable to refresh its details.")); }} />
        : <p role="status">Payment could not be started. Close this window; your booking has not changed.</p>}
    </> : adjustment.adjustmentStatus !== "applied" && <p className="text-muted-foreground">The original booking was preserved.</p>}
  </section>;
  const fixedLocation = location ?? context.location;
  const lesson = context.coaching;
  const reservation = { ...context, id: booking.id, reason: null,
    location_name: fixedLocation.name, court_name: fixedLocation.courts.find((c) => c.id === context.court_id)?.name ?? "Court" };
  const canSave = (draft: ReservationEditDraft) => quote?.key === draftKey(draft)
    && (!(quote.total !== context.total_amount_minor || quote.requiresConfirmation) || acknowledged);
  const price = (draft: ReservationEditDraft, pending: boolean) => <BookingPrice id={booking.id} context={context} draft={draft} currency={booking.currency}
    actions={actions} pending={pending} quote={quote} acknowledged={acknowledged} onQuote={receiveQuote} onAcknowledge={setAcknowledged} />;
  const save = async (draft: ReservationEditDraft): Promise<ReservationEditSaveResult> => {
    if (!quote || quote.key !== draftKey(draft)) return { ok: false, message: "Wait for the recalculated total before saving." };
    if ((quote.total !== context.total_amount_minor || quote.requiresConfirmation) && !acknowledged)
      return { ok: false, message: "Confirm the new total before saving." };
    const key = draftKey(draft);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const result = await actions.save({ requestId: request.current.id, ...editInput(booking.id, context, draft),
      save: true, expectedTotal: quote.total, priceAcknowledged: acknowledged });
    if (result.ok && result.adjustmentId) {
      setAdjustment(result);
      // Only a payment-backed proposal can be dismissed; a refund-backed one resolves automatically.
      onAdjustment?.(result.adjustmentStatus === "pending" && !result.refundStatus ? result.adjustmentId : null);
      return { ok: true as const, pending: true, message: result.adjustmentStatus === "applied"
        ? result.refundStatus === "succeeded" ? "Booking updated and refund completed."
          : "Booking updated. Part of the refund could not be completed; the club will contact you."
        : result.adjustmentStatus === "pending" && result.refundStatus ? "Change requested. It is applied once the refund is confirmed."
        : result.adjustmentStatus === "unsuccessful" && result.refundStatus ? "The refund could not be processed, so your booking was not changed."
        : result.adjustmentStatus === "pending" ? "Complete the additional payment to update your booking."
        : "The previous modification has ended. Check its financial outcome." };
    }
    if (!result.ok && "reason" in result && result.reason === "price_changed" && result.totalAmountMinor !== undefined) {
      receiveQuote({ key: draftKey(draft), total: result.totalAmountMinor, requiresConfirmation: true });
    }
    return result;
  };
  if (lesson) return <ReservationEditForm reservation={reservation} inProgress={false} scheduleOnly loadAvailability={loadLessonDay}
    initialAvailability={initialAvailability}
    onCancel={onCancel} onPendingChange={onPendingChange} canSave={canSave}
    renderTimetable={(input) => <LessonTimetable {...input} timezone={context.location_timezone} currency={booking.currency} />}
    renderScheduleDetails={(draft, pending) => <>
      <LessonChange context={context} lesson={lesson} draft={draft} />
      {price(draft, pending)}
    </>}
    onSave={save} onSaved={onSaved} />;
  return <ReservationEditForm<ReservationTimetableDay> reservation={reservation} inProgress={false} scheduleOnly loadAvailability={actions.load}
    initialAvailability={initialAvailability}
    onCancel={onCancel} onPendingChange={onPendingChange} canSave={canSave}
    renderScheduleDetails={price} onSave={save} onSaved={onSaved} />;
}
