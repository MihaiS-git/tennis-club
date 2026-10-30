"use client";

import { CalendarClock } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { StaffCalendarContext, useStaffCalendar } from "@/components/staff-calendar-context";
import type { OperationalBookingDay } from "@/lib/bookings/operational-availability";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { formatMoney } from "@/lib/pricing/money";
import type { AdminBookingEditor } from "@/lib/bookings/admin-edit";
import type { OperationalChangeInput, OperationalFinancialQuote, OperationalRejection } from "@/lib/bookings/operational-policy";
import { loadAdminBookingEditorAction, loadAdminBookingDayAction, changeAdminBookingAction } from "./actions";

const messages: Record<OperationalRejection, string> = {
  unavailable: "This booking or destination is no longer available.", stale: "This booking changed. Exit rescheduling and reopen it.",
  invalid_target: "Check the destination and start time.", cross_currency: "Bookings cannot move between currencies.",
  inactive_original: "The original court or location is inactive.", change_pending: "A financial operation is pending. Wait for it to finish.",
  started: "Started bookings cannot be edited.", timezone: "The club timezone configuration needs attention.",
  override_denied: "The Coach override is not permitted.", coach_ineligible: "Choose an active Coach.",
  "invalid-time": "Choose a valid time within one opening interval.", "coach-unavailable": "The Coach is unavailable.",
  "coach-booked": "The Coach already has a booking at that time.", "court-unavailable": "The court is already booked at that time.",
  unpriced: "No price is configured for this interval.", operation_key_reused: "This request has already been used. Exit rescheduling and reopen it.",
  financial_review_required: "The booking's financial state needs review before editing.",
  financial_confirmation_required: "Review and confirm the financial quote.", financial_changed: "The quote changed. Request a new preview and confirm it.",
};
const selectClass = "mt-1 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm";

type BookingEditProps = { bookingId: string; startsAt?: string;
  onStart?: () => void; variant?: "button" | "icon" };
export type EditorActions = {
  load: (id: unknown) => Promise<AdminBookingEditor & { actingCoachId?: string }>;
  change: typeof changeAdminBookingAction;
  day: (input: unknown) => Promise<OperationalBookingDay | { ok: false; message: string }>;
};
export const adminActions: EditorActions = { load: loadAdminBookingEditorAction, change: changeAdminBookingAction, day: loadAdminBookingDayAction };

export function AdminBookingEdit(props: BookingEditProps) {
  return <OperationalBookingEdit {...props} capacity="admin" />;
}

// Entry points navigate to the shared Calendar; only that Calendar loads scheduling data.
export function OperationalBookingEdit({ bookingId, startsAt, onStart, variant = "button", capacity }: BookingEditProps & {
  capacity: "admin" | "coach";
}) {
  const router = useRouter();
  const calendar = useStaffCalendar();
  const [started, setStarted] = useState(() => !!startsAt && Date.parse(startsAt) <= Date.now());
  useEffect(() => {
    if (!startsAt) return;
    const timer = setTimeout(() => setStarted(true), Math.max(0, Math.min(2_147_483_647, Date.parse(startsAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [startsAt]);
  const label = capacity === "coach" ? "Reschedule lesson" : "Edit booking";
  return <Button type="button" variant="secondary" size={variant === "icon" ? "icon" : undefined}
    className={variant === "icon" ? "relative z-10" : undefined} aria-label={label} title={label} disabled={started}
    onClick={() => { onStart?.(); if (calendar) { calendar.start(bookingId); return; } router.push(`/${capacity}/bookings?${new URLSearchParams({ view: "calendar", reschedule: bookingId })}`); }}>
    {variant === "icon" ? <CalendarClock size={14} aria-hidden="true" /> : label}</Button>;
}

export function OperationalCalendarReschedule({ bookingId, capacity, actions, initialData, locationId, date, children }: {
  bookingId?: string; capacity: "admin" | "coach"; actions: EditorActions;
  initialData?: AdminBookingEditor & { actingCoachId?: string };
  locationId: string; date: string | null; children: ReactNode;
}) {
  const router = useRouter();
  const titleId = useId();
  const busy = useRef(false);
  const [activeId, setActiveId] = useState(bookingId);
  const [serverBookingId, setServerBookingId] = useState(bookingId);
  const [pending, setPending] = useState(false);
  const [exiting, startExit] = useTransition();
  const [error, setError] = useState("");
  const [data, setData] = useState<(AdminBookingEditor & { actingCoachId?: string }) | null>(null);
  const [target, setTarget] = useState<OperationalChangeInput | null>(null);
  const [availability, setAvailability] = useState<{ key: string; value: OperationalBookingDay } | null>(null);
  const [availabilityError, setAvailabilityError] = useState<{ key: string; message: string } | null>(null);
  const [availabilityVersion, setAvailabilityVersion] = useState(0);
  const [quote, setQuote] = useState<OperationalFinancialQuote | null>(null);
  if (serverBookingId !== bookingId) {
    setServerBookingId(bookingId); setActiveId(bookingId);
    setData(null); setTarget(null); setQuote(null); setError("");
  }
  const initialize = useEffectEvent(async (requestedId: string) => {
    const result = requestedId === bookingId && initialData ? initialData : await actions.load(requestedId);
    return { result, locationId, date };
  });
  useEffect(() => {
    if (!activeId) return;
    const requestedId = activeId;
    let disposed = false;
    async function load() {
      setPending(true);
      try {
        const { result, locationId, date } = await initialize(requestedId);
        if (disposed) return;
        setData(result);
        setTarget({ id: requestedId, expectedRevisionId: result.tokens.current_revision_id, expectedUpdatedAt: result.tokens.updated_at,
          locationId, courtId: result.tokens.location_id === locationId && result.booking.booking_date === date ? result.tokens.court_id : "", date: date ?? result.booking.booking_date,
          startMinute: result.booking.starts_at_minute, overrideCoachRestrictions: true, save: false, requestId: crypto.randomUUID(),
          ...(result.booking.coach_user_id ? { coachUserId: result.booking.coach_user_id } : {}) });
      } catch { if (!disposed) setError("Unable to load this booking. Exit rescheduling and try again."); }
      finally { if (!disposed) setPending(false); }
    }
    void load();
    return () => { disposed = true; };
  // Navigation while editing is handled by the existing controls through context.
  // A new booking initializes once; changing the destination never reloads its editor.
  }, [activeId]);
  const availabilityKey = JSON.stringify([activeId, target?.locationId, target?.date, target?.coachUserId, availabilityVersion]);
  const current = availability?.key === availabilityKey ? availability.value : null;
  const targetLocation = target?.locationId;
  const targetDate = target?.date;
  const targetCoach = target?.coachUserId;
  const revisionId = data?.tokens.current_revision_id;
  const updatedAt = data?.tokens.updated_at;
  useEffect(() => {
    if (!activeId || !targetLocation || !targetDate || !revisionId || !updatedAt) return;
    let disposed = false;
    void actions.day({ id: activeId, locationId: targetLocation, date: targetDate,
      ...(targetCoach ? { coachUserId: targetCoach } : {}) }).then(value => {
        if (disposed) return;
        if ("ok" in value) throw new Error(value.message);
        if (value.tokens.current_revision_id !== revisionId || value.tokens.updated_at !== updatedAt)
          throw new Error(messages.stale);
        setAvailability({ key: availabilityKey, value });
        setAvailabilityError(null);
      }).catch((cause: unknown) => {
        if (!disposed) setAvailabilityError({ key: availabilityKey, message: cause instanceof Error ? cause.message : "Unable to load availability." });
      });
    return () => { disposed = true; };
  }, [actions, activeId, availabilityKey, targetLocation, targetDate, targetCoach, revisionId, updatedAt]);
  const availabilityReady = !!current?.starts.some(start => start.courtId === target?.courtId && start.startMinute === target?.startMinute);
  const duration = data ? data.booking.ends_at_minute - data.booking.starts_at_minute : 0;
  const starts = new Set(current?.starts.map(start => `${start.courtId}:${start.startMinute}`));
  const rescheduleDay = current && { ...current.day, courts: current.day.courts.map(row => ({ ...row,
    cells: row.cells.map((cell, index) => cell === "available" && !starts.has(`${row.court.id}:${current.day.times[index]}`) ? "unavailable" as const : cell) })) };
  const startRow = current?.day.times.indexOf(target?.startMinute ?? -1) ?? -1;
  const selection = target && availabilityReady && startRow >= 0 ? { courtId: target.courtId, startMinute: target.startMinute,
    endMinute: target.startMinute + duration, startRow, endRow: startRow + duration / 30 } : null;
  function calendarUrl(id?: string, destination = target) {
    const query = new URLSearchParams({ view: "calendar" });
    if (destination) { query.set("location", destination.locationId); query.set("date", destination.date); }
    else { query.set("location", locationId); if (date) query.set("date", date); }
    if (id) query.set("reschedule", id);
    return `/${capacity}/bookings?${query}`;
  }
  function start(id: string) {
    setData(null); setTarget(null); setQuote(null); setError(""); setActiveId(id);
    window.history.replaceState(null, "", calendarUrl(id, null));
  }
  function exit(refresh = false) {
    const url = calendarUrl();
    startExit(() => {
      if (target && (target.locationId !== locationId || target.date !== date)) router.replace(url);
      else { window.history.replaceState(null, "", url); if (refresh) router.refresh(); }
      setActiveId(undefined); setData(null); setTarget(null); setQuote(null); setError("");
      setAvailability(null); setAvailabilityError(null);
    });
  }
  function update(values: Partial<OperationalChangeInput>) {
    setTarget(t => t && ({ ...t, ...values, requestId: crypto.randomUUID() })); setQuote(null); setError("");
  }
  function navigate(location: string, selectedDate: string) {
    if (!target || pending || !selectedDate) return;
    if (location === target.locationId && selectedDate === target.date) return;
    const destination = { ...target, locationId: location, date: selectedDate, courtId: "" };
    update(destination);
    window.history.replaceState(null, "", calendarUrl(activeId, destination));
  }
  async function run(save: boolean) {
    if (!target || !target.courtId || !availabilityReady || busy.current) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await actions.change({ ...target, save, ...(save && quote ? { financialAcceptance: quote } : {}) });
      if (!result.ok) {
        setError(messages[result.reason]); setQuote(null);
        if (["court-unavailable", "coach-booked", "coach-unavailable"].includes(result.reason)) {
          setAvailabilityVersion(version => version + 1);
          setTarget(value => value && ({ ...value, courtId: "" }));
        }
        return;
      }
      if (!save) {
        if (!result.financial) { setError("Choose a different destination or Coach to change this booking."); return; }
        setQuote(result.financial); return;
      }
      const waiting = result.adjustmentStatus === "pending";
      if (result.adjustmentStatus && result.adjustmentStatus !== "pending" && result.adjustmentStatus !== "applied") {
        toast.error("The refund could not complete. The booking has not changed.");
      } else {
        toast.success(waiting ? "Change requested. The original booking remains confirmed until the refund settles."
          : result.refundStatus === "succeeded" ? "Booking updated. The refund completed." : "Booking updated.");
      }
      exit(true);
    } catch { setError("Unable to process this change. Try again; the same request can be safely retried."); }
    finally { busy.current = false; setPending(false); }
  }
  return <StaffCalendarContext value={{ active: !!activeId, start, navigate, target,
    pending: pending || exiting || !!activeId && !current,
    loading: pending || exiting || !!activeId && !current && !error && availabilityError?.key !== availabilityKey, day: rescheduleDay, selection, duration,
    original: data && target?.locationId === data.tokens.location_id && target.date === data.booking.booking_date
      ? { courtId: data.tokens.court_id, startMinute: data.booking.starts_at_minute, endMinute: data.booking.ends_at_minute } : undefined,
    choose: (courtId, startMinute) => update({ courtId, startMinute }),
    toolbar: activeId ? <section aria-labelledby={titleId} className="mt-4 min-w-0 rounded-card border-2 border-accent bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="font-heading text-xl font-semibold text-primary">Rescheduling booking</h2>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => exit()}>Exit rescheduling</Button>
      </div>
      {pending && <p role="status" className="my-3">{data ? "Checking booking…" : "Loading booking and options…"}</p>}
      {(error || availabilityError?.key === availabilityKey) && <p role="alert" className="my-3 text-sm text-danger">{error || availabilityError?.message}</p>}
      {data && target && <>
        <div className="my-3 text-sm">
          <p className="font-semibold">Current booking · {data.booking.customer_name}</p>
          <p>{data.booking.location_name} · {data.booking.court_name} · {data.booking.booking_date} · {minuteToTime(data.booking.starts_at_minute)}–{minuteToTime(data.booking.ends_at_minute)} ({data.booking.location_timezone})</p>
          {data.booking.coaching && <p>{data.booking.coaching_program_name} · {data.booking.coach_name} · {data.booking.coaching.participantCount} participants · agreed lesson fee {formatMoney(data.booking.coaching.amountMinor, data.booking.currency)}</p>}
        </div>
        <form onSubmit={e => { e.preventDefault(); void run(false); }}>
          <p role="status" className="my-3 text-sm font-medium">{selection && target
            ? `Selected destination: ${data.locations.find(location => location.id === target.locationId)?.courts.find(court => court.id === target.courtId)?.name} · ${target.date} · ${minuteToTime(target.startMinute)}–${minuteToTime(target.startMinute + duration)}`
            : "Choose a destination on the timetable."}</p>
          {!current && availabilityError?.key !== availabilityKey && <p role="status">Loading court availability…</p>}
          <fieldset disabled={pending} className="max-w-sm">
            {data.booking.includes_coaching && <label className="text-sm font-medium">Assigned Coach<select className={selectClass} required value={target.coachUserId} onChange={e => update({ coachUserId: e.target.value, overrideCoachRestrictions: capacity === "admin" || e.target.value === data.actingCoachId })}>
              {data.coaches.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>}
          </fieldset>
          <p className="my-3 text-sm text-muted-foreground">Duration: {data.booking.ends_at_minute - data.booking.starts_at_minute} minutes. {capacity === "admin" ? "Coach working hours, time off, location and program restrictions may be overridden by Admins."
            : "You may override your own working hours, time off and location assignments. A replacement Coach must be available; program assignments do not restrict reassignment."} Court and Coach conflicts always apply.</p>
          <Button type="submit" variant="secondary" disabled={pending || !availabilityReady || !target.courtId}>Preview change</Button>
        </form>
        {quote && <section aria-label="Financial preview" className="mt-5 space-y-3 border-t border-border pt-4 text-sm">
          <h3 className="font-semibold">Proposed booking</h3>
          <p>{data.locations.find(l => l.id === target.locationId)?.name} · {data.locations.find(l => l.id === target.locationId)?.courts.find(c => c.id === target.courtId)?.name}<br />
            {target.date} · {minuteToTime(target.startMinute)}–{minuteToTime(target.startMinute + data.booking.ends_at_minute - data.booking.starts_at_minute)}
            {target.coachUserId && <> · {data.coaches.find(c => c.id === target.coachUserId)?.name}</>}</p>
          <dl className="grid grid-cols-2 gap-2">
            {([ ["Current agreed amount", quote.currentAmountMinor], ["Destination price", quote.destinationAmountMinor],
              ["Automatic refund", quote.refundMinor], ["Absorbed by club", quote.absorbedMinor], ["Final customer obligation", quote.customerAmountMinor] ] as const).map(([label, amount]) =>
              <div key={label} className="contents"><dt>{label}</dt><dd>{formatMoney(amount, quote.currency)} · {quote.currency}</dd></div>)}
          </dl>
          <p>{quote.consequence === "none" ? "No financial adjustment." : quote.consequence === "refund" ? "The original booking remains confirmed until all refunds complete." : quote.consequence === "club_absorbs" ? "The club pays the increase. No additional customer charge." : "The amount owed is reduced."}</p>
          <Button type="button" disabled={pending} onClick={() => void run(true)}>Confirm booking change</Button>
        </section>}
      </>}
    </section> : null }} >{children}</StaffCalendarContext>;
}
