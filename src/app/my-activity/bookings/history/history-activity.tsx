"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import { historyStatus, type CourtHistoryItem } from "@/lib/bookings/history";
import { formatMoney } from "@/lib/pricing/money";
import { dateLabel, ReservationDetails, timeLabel } from "../personal-activity";

export function HistoryActivity({ rows, page = 1 }: { rows: CourtHistoryItem[]; page?: number }) {
  const [selected, setSelected] = useState<CourtHistoryItem | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  return <>
    {rows.length ? <ul className="divide-y divide-border rounded-control border border-border bg-background">
      {rows.map((row) => <li key={`${row.kind}:${row.id}`}><button type="button"
        onClick={(event) => { returnFocusRef.current = event.currentTarget; setSelected(row); }}
        className="w-full p-3 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary">
        <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">{row.kind === "booking" ? "Booking" : "Reservation"}</span>
        <span className="block text-sm font-semibold text-primary">{row.location_name} · {row.court_name}</span>
        <span className="mt-1 block text-sm text-foreground">{dateLabel(row.booking_date)} · {timeLabel(row.starts_at_minute)}–{timeLabel(row.ends_at_minute)} · {row.ends_at_minute - row.starts_at_minute} min</span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">{row.kind === "booking" ? `${formatMoney(row.total_amount_minor, row.currency)} · ` : ""}{historyStatus(row)}{row.kind === "reservation" && row.reason ? ` · ${row.reason}` : ""}</span>
      </button></li>)}
    </ul> : <p className="text-sm text-muted-foreground">{page === 1 ? "No previous or cancelled court activity." : "No booking history on this page."}</p>}
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
