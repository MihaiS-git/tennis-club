"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
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
        <DialogHeader titleId={titleId} title={selected.kind === "booking" ? "Booking details" : "Reservation details"} status={historyStatus(selected)} onClose={() => dialogRef.current?.close()} />
        {selected.kind === "reservation" ? <ReservationDetails reservation={selected} /> :
          <BookingDetails booking={selected} />}
        <DialogFooter><button type="button" onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
      </ModalDialog>, document.body)}
  </>;
}
