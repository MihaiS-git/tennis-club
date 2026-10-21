"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/button";
import { StatusBadge } from "@/components/status-badge";
import type { CoachAvailabilityExceptionRow, CoachAvailabilityView, CoachWeeklyInterval } from "@/lib/coaching/availability";
import { availabilityWeekdays, formatAvailabilityRange } from "@/lib/coaching/availability-validation";
import { ExceptionDialog, exceptionKindLabels, locationLabel, WeeklyIntervalDialog, type AvailabilityChangeAction } from "./availability-dialogs";

const sectionTitle = "mb-1 font-heading text-xl font-semibold text-primary";
const sectionHint = "mb-3 max-w-3xl text-sm text-muted-foreground";
const emptyClass = "rounded-card border border-border bg-surface px-4 py-5 text-sm text-muted-foreground";

const dateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function formatDate(date: string) {
  return dateFormat.format(new Date(`${date}T00:00:00Z`));
}

// Validity of working hours that do not simply apply from today onwards.
function validityLabel(interval: CoachWeeklyInterval, today: string) {
  if (interval.valid_from > today) return interval.valid_until
    ? `${formatDate(interval.valid_from)} – ${formatDate(interval.valid_until)}` : `from ${formatDate(interval.valid_from)}`;
  return interval.valid_until ? `until ${formatDate(interval.valid_until)}` : "";
}

type WeeklyEdit = { interval?: CoachWeeklyInterval };
type ExceptionEdit = { exception?: CoachAvailabilityExceptionRow; kind?: "unavailable" | "available" };

// Shared by the Coach area and Admin coaching. The action decides whose schedule
// changes: the session coach, or the coach an Admin selected.
export function AvailabilityManager({ view, action, readOnly = false }: {
  view: CoachAvailabilityView; action: AvailabilityChangeAction; readOnly?: boolean;
}) {
  const [weeklyEdit, setWeeklyEdit] = useState<WeeklyEdit | null>(null);
  const [exceptionEdit, setExceptionEdit] = useState<ExceptionEdit | null>(null);
  const locations = new Map(view.locations.map((location) => [location.id, location]));
  const current = view.locations.filter((location) => !location.archived);
  const canAdd = !readOnly && current.length > 0;
  const upcoming = view.exceptions.filter((exception) => exception.until_date >= view.today);
  const past = view.exceptions.filter((exception) => exception.until_date < view.today).reverse();
  // Working hours are dated in their location's calendar; ended ones are history.
  const localToday = (interval: CoachWeeklyInterval) => locations.get(interval.location_id)?.today ?? view.today;
  const weekly = view.weekly.filter((interval) => interval.valid_until === null || interval.valid_until >= localToday(interval));
  const endedWeekly = view.weekly.filter((interval) => !weekly.includes(interval));

  function exceptionRows(rows: CoachAvailabilityExceptionRow[], editable: boolean) {
    return <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[40rem] text-left font-sans text-sm" aria-label={editable ? "Upcoming date exceptions" : "Past date exceptions"}>
        <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5">Date</th>
            <th scope="col" className="px-4 py-2.5">Type</th>
            <th scope="col" className="px-4 py-2.5">Time</th>
            <th scope="col" className="px-4 py-2.5">Location</th>
            <th scope="col" className="px-4 py-2.5">Note</th>
            <th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((exception) => <tr key={exception.id} className="align-top">
            <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{formatDate(exception.date)}{exception.until_date !== exception.date ? ` – ${formatDate(exception.until_date)}` : ""}</td>
            <td className="px-4 py-3"><StatusBadge tone={exception.kind === "available" ? "success" : "warning"}>{exceptionKindLabels[exception.kind]}</StatusBadge></td>
            <td className="whitespace-nowrap px-4 py-3">{exception.start_minute === null || exception.end_minute === null ? "Whole day"
              : formatAvailabilityRange(exception.start_minute, exception.end_minute)}</td>
            <td className="px-4 py-3">{exception.location_id ? locationLabel(locations.get(exception.location_id)) : "All locations"}</td>
            <td className="max-w-56 break-words px-4 py-3 text-muted-foreground">{exception.note || "—"}</td>
            <td className="px-4 py-3 text-right">
              <Button type="button" variant="secondary" size="small" fullWidth={false} onClick={() => setExceptionEdit({ exception })}
                aria-label={`${editable && !readOnly ? "Edit" : "View"} exception on ${formatDate(exception.date)}`}>{editable && !readOnly ? "Edit" : "View"}</Button>
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>;
  }

  return <div className="space-y-8">
    <section aria-labelledby="availability-locations">
      <h2 id="availability-locations" className={sectionTitle}>Assigned locations</h2>
      <p className={sectionHint}>Availability can be set only at these locations. Times are local to each location. Admin manages assignments.</p>
      {view.locations.length ? <ul className="flex flex-wrap gap-2">
        {view.locations.map((location) => <li key={location.id} className="rounded-control border border-border bg-surface px-3 py-2 text-sm">
          <span className="font-semibold text-foreground">{locationLabel(location)}</span>
          <span className="ml-2 text-xs text-muted-foreground">{location.timezone}</span>
        </li>)}
      </ul> : <p className={emptyClass}>No locations assigned yet. Ask an Admin to assign a location before adding availability.</p>}
    </section>

    <section aria-labelledby="availability-weekly">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="availability-weekly" className={sectionTitle}>Weekly schedule</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">Regular working hours, always within each location&apos;s opening hours; they are trimmed automatically when opening hours shrink. Intervals cannot overlap, even at different locations. Availability alone does not make a lesson bookable.</p>
        </div>
        {canAdd && <Button type="button" size="small" fullWidth={false} onClick={() => setWeeklyEdit({})}>
          <Plus aria-hidden className="mr-1 size-4" />Add working hours</Button>}
      </div>
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {availabilityWeekdays.map((day, weekday) => {
          const intervals = weekly.filter((interval) => interval.weekday === weekday);
          return <li key={day} className="grid gap-2 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
            <p className="text-sm font-semibold text-foreground">{day}</p>
            {intervals.length ? <ul className="flex flex-wrap gap-2" aria-label={`${day} working hours`}>
              {intervals.map((interval) => <li key={interval.id}>
                <button type="button" onClick={() => setWeeklyEdit({ interval })}
                  className="rounded-control border border-border bg-background px-3 py-1.5 text-left text-sm transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  <span className="font-semibold text-foreground">{formatAvailabilityRange(interval.start_minute, interval.end_minute)}</span>
                  <span className="ml-2 text-muted-foreground">{locationLabel(locations.get(interval.location_id))}</span>
                  {validityLabel(interval, localToday(interval)) && <span className="ml-2 text-xs text-muted-foreground">{validityLabel(interval, localToday(interval))}</span>}
                </button>
              </li>)}
            </ul> : <p className="text-sm text-muted-foreground">Not available</p>}
          </li>;
        })}
      </ul>
      {endedWeekly.length > 0 && <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">Ended working hours ({endedWeekly.length})</summary>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Ended working hours">
          {endedWeekly.map((interval) => <li key={interval.id}>
            <button type="button" onClick={() => setWeeklyEdit({ interval })}
              className="rounded-control border border-border bg-background px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              {availabilityWeekdays[interval.weekday]} {formatAvailabilityRange(interval.start_minute, interval.end_minute)} · {locationLabel(locations.get(interval.location_id))}
              {" "}· {formatDate(interval.valid_from)} – {formatDate(interval.valid_until as string)}
            </button>
          </li>)}
        </ul>
      </details>}
    </section>

    <section aria-labelledby="availability-exceptions">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="availability-exceptions" className={sectionTitle}>Time off and extra availability</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">Vacations, appointments or additional hours. An exception replaces the weekly schedule for its time.</p>
        </div>
        {canAdd && <Button type="button" variant="secondary" size="small" fullWidth={false} onClick={() => setExceptionEdit({ kind: "unavailable" })}>Add time off</Button>}
        {canAdd && <Button type="button" variant="secondary" size="small" fullWidth={false} onClick={() => setExceptionEdit({ kind: "available" })}>Add extra availability</Button>}
      </div>
      {upcoming.length ? exceptionRows(upcoming, true) : <p className={emptyClass}>No upcoming exceptions. The weekly schedule applies.</p>}
      {past.length > 0 && <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">Past exceptions ({past.length})</summary>
        <div className="mt-2">{exceptionRows(past, false)}</div>
      </details>}
    </section>

    {weeklyEdit && <WeeklyIntervalDialog key={weeklyEdit.interval?.id ?? "new"} interval={weeklyEdit.interval}
      locations={view.locations} action={action} readOnly={readOnly}
      open onOpenChange={(open) => { if (!open) setWeeklyEdit(null); }} />}
    {exceptionEdit && <ExceptionDialog key={exceptionEdit.exception?.id ?? "new"} exception={exceptionEdit.exception} kind={exceptionEdit.kind}
      locations={view.locations} today={view.today} horizon={view.horizon} action={action}
      readOnly={readOnly || (exceptionEdit.exception !== undefined && exceptionEdit.exception.until_date < view.today)}
      open onOpenChange={(open) => { if (!open) setExceptionEdit(null); }} />}
  </div>;
}
