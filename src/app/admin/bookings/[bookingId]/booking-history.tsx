import { reservationDateLabel } from "@/components/reservation-details";
import { StatusBadge } from "@/components/status-badge";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { bookingCreatedLabel } from "@/lib/bookings/admin-query";
import { hasRecordedChanges, type BookingHistoryEvent, type HistorySchedule } from "@/lib/bookings/admin-history";
import { formatMoney } from "@/lib/pricing/money";

function Schedule({ label, value, timezone }: { label: string; value: HistorySchedule; timezone: string }) {
  return <div className="min-w-0">
    <p className="text-xs font-semibold text-muted-foreground">{label}</p>
    <p>{value.locationName} · {value.courtName}</p>
    <p>{reservationDateLabel(value.date)} · {minuteToTime(value.startMinute)}–{minuteToTime(value.endMinute)}
      {value.timezone !== timezone && ` (${value.timezone})`}</p>
    <p className="font-semibold tabular-nums">{formatMoney(value.total, value.currency)}</p>
  </div>;
}

// Chronological timeline of persisted revisions and change requests. Times use the
// booking's location timezone; inferred entries are labelled as such.
export function BookingHistory({ events, timezone }: { events: BookingHistoryEvent[]; timezone: string }) {
  return <section aria-labelledby="booking-history" className="rounded-card border border-border bg-surface p-5">
    <h2 id="booking-history" className="font-heading text-base font-semibold text-primary">Booking history</h2>
    <p className="mt-1 text-xs text-muted-foreground">Recorded booking versions and change requests · Times in {timezone}</p>
    <ol className="mt-4 border-l border-border">
      {events.map((event) => <li key={event.key} className="relative pb-5 pl-5 last:pb-0">
        <span aria-hidden className={`absolute -left-[5px] top-1.5 size-2.5 rounded-full ${event.recorded ? "bg-primary" : "border border-muted-foreground bg-surface"}`} />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">{event.label}
            <StatusBadge tone={event.status.tone}>{event.status.label}</StatusBadge></h3>
          {event.at ? <time dateTime={event.at} className="text-xs text-muted-foreground tabular-nums">{bookingCreatedLabel(event.at, timezone)}</time>
            : <span className="text-xs text-muted-foreground">Time not recorded</span>}
        </div>
        {event.detail && <p className="mt-1 text-xs text-muted-foreground">{event.detail}
          {event.requestedAt && ` · Requested ${bookingCreatedLabel(event.requestedAt, timezone)}`}</p>}
        {(event.previous || event.next) && <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
          {event.previous && <Schedule label="Previous" value={event.previous} timezone={timezone} />}
          {event.next && <Schedule label={event.kind === "request" ? "Requested" : event.previous ? "New" : "Booking"}
            value={event.next} timezone={timezone} />}
        </div>}
      </li>)}
    </ol>
    {!hasRecordedChanges(events) && <p className="mt-4 text-sm text-muted-foreground">No modifications or cancellations were recorded.</p>}
  </section>;
}
