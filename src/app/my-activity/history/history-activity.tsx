"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import { historyStatus, type CourtHistoryItem } from "@/lib/bookings/history";
import { parseActivityQuery, type ActivityQuery } from "@/lib/bookings/activity-query";
import { ActivityTable } from "../activity-table";
import { formatMoney } from "@/lib/pricing/money";
import { dateLabel, ReservationDetails, timeLabel } from "../bookings/personal-activity";

export function HistoryActivity({ rows, page = 1, staff = false, query = parseActivityQuery({}, "history", staff) }: {
  rows: CourtHistoryItem[]; page?: number; staff?: boolean; query?: ActivityQuery;
}) {
  const [selected, setSelected] = useState<CourtHistoryItem | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLTableRowElement>(null);
  const titleId = useId();

  function openDetails(row: CourtHistoryItem, element: HTMLTableRowElement) {
    returnFocusRef.current = element;
    setSelected(row);
  }

  return <>
    {rows.length ? <ActivityTable scope="history" query={query} staff={staff}>
      {rows.map((row) => <tr key={`${row.kind}:${row.id}`} tabIndex={0}
        aria-label={`Details for ${row.court_name} on ${dateLabel(row.booking_date)}`}
        onClick={(event) => openDetails(row, event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(row, event.currentTarget); }
        }}
        className="cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
        {staff && <td className="whitespace-nowrap px-3 py-3">{row.kind === "booking" ? "Booking" : "Reservation"}</td>}
        <td className="px-3 py-3 font-semibold text-primary">{row.location_name}</td>
        <td className="px-3 py-3">{row.court_name}</td>
        <td className="whitespace-nowrap px-3 py-3">{dateLabel(row.booking_date)}</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{timeLabel(row.starts_at_minute)}–{timeLabel(row.ends_at_minute)}</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{row.ends_at_minute - row.starts_at_minute} min</td>
        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{row.kind === "booking" ? formatMoney(row.total_amount_minor, row.currency) : "—"}</td>
        <td className="px-3 py-3"><span className="inline-flex rounded-full bg-surface-muted px-2 py-1 text-xs font-semibold">{historyStatus(row)}</span></td>
      </tr>)}
    </ActivityTable> : <p className="text-sm text-muted-foreground">{page === 1 ? "No completed or cancelled court activity matches your filters." : "No booking history on this page."}</p>}
    {selected && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId} onClose={() => { setSelected(null); returnFocusRef.current?.focus(); }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
        <h2 id={titleId} className="font-heading text-lg font-semibold">{selected.kind === "booking" ? "Booking details" : "Reservation details"}</h2>
        {selected.kind === "reservation" ? <ReservationDetails reservation={selected} /> :
          <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Location</dt><dd>{selected.location_name}</dd>
            <dt className="text-muted-foreground">Court</dt><dd>{selected.court_name}</dd>
            <dt className="text-muted-foreground">Date</dt><dd>{dateLabel(selected.booking_date)}</dd>
            <dt className="text-muted-foreground">Time</dt><dd>{timeLabel(selected.starts_at_minute)}–{timeLabel(selected.ends_at_minute)} ({selected.location_timezone})</dd>
            <dt className="text-muted-foreground">Duration</dt><dd>{selected.ends_at_minute - selected.starts_at_minute} min</dd>
            <dt className="col-span-2 mt-2 font-semibold">Contact</dt>
            <dt className="text-muted-foreground">Name</dt><dd>{selected.customer_name}</dd>
            <dt className="text-muted-foreground">Email</dt><dd>{selected.customer_email}</dd>
            <dt className="text-muted-foreground">Phone</dt><dd>{selected.customer_phone}</dd>
            <dt className="text-muted-foreground">Total</dt><dd>{formatMoney(selected.total_amount_minor, selected.currency)}</dd>
            <dt className="text-muted-foreground">Status</dt><dd>{historyStatus(selected)}</dd>
          </dl>}
        <div className="mt-5 flex justify-end"><button type="button" onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></div>
      </ModalDialog>, document.body)}
  </>;
}
