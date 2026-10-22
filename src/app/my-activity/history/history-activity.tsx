"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { DialogHeader, DialogFooter } from "@/components/dialog-layout";
import { BookingDetails } from "@/components/booking-details";
import { ModalDialog } from "@/components/modal-dialog";
import { historyStatus, type CourtHistoryItem, type CustomerBookingHistoryItem } from "@/lib/bookings/history";
import { activityBookingHref, activityHref, parseActivityQuery, type ActivityQuery } from "@/lib/bookings/activity-query";
import { bookingTypeDetail, bookingTypeLabel } from "@/lib/bookings/booking-type";
import { ActivityRow, ActivityTable } from "../activity-table";
import { StatusBadge } from "@/components/status-badge";
import { BookingPayment } from "../booking-payment";
import { formatMoney } from "@/lib/pricing/money";
import { dateLabel, ReservationDetails, timeLabel } from "../bookings/personal-activity";

// Completed time reads as settled; cancelled time is muted, not an error.
function historyTone(item: CourtHistoryItem) {
  return item.status === "cancelled" ? "neutral" as const : "success" as const;
}

export function HistoryActivity({ rows, page = 1, staff = false, query = parseActivityQuery({}, "history", staff), deepLinkedBooking = null }: {
  rows: CourtHistoryItem[]; page?: number; staff?: boolean; query?: ActivityQuery;
  deepLinkedBooking?: CustomerBookingHistoryItem | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<CourtHistoryItem | null>(deepLinkedBooking);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLTableRowElement>(null);
  const titleId = useId();

  function openDetails(row: CourtHistoryItem, element: HTMLTableRowElement) {
    returnFocusRef.current = element;
    setSelected(row);
    if (row.kind === "booking") router.replace(activityBookingHref("history", query, row.id), { scroll: false });
  }

  return <>
    {rows.length ? <ActivityTable scope="history" query={query}>
      {rows.map((row) => <ActivityRow key={`${row.kind}:${row.id}`}
        label={`Details for ${row.court_name} on ${dateLabel(row.booking_date)}`}
        onOpen={(element) => openDetails(row, element)}
        type={row.kind === "booking" ? bookingTypeLabel(row) : "Reservation"}
        typeDetail={row.kind === "booking" ? bookingTypeDetail(row) : undefined}
        location={row.location_name} court={row.court_name} date={dateLabel(row.booking_date)}
        time={`${timeLabel(row.starts_at_minute)}–${timeLabel(row.ends_at_minute)}`}
        duration={`${row.ends_at_minute - row.starts_at_minute} min`}
        total={row.kind === "booking" ? formatMoney(row.total_amount_minor, row.currency) : "—"}
        status={<StatusBadge tone={historyTone(row)}>{historyStatus(row)}</StatusBadge>} />)}
    </ActivityTable> : <p className="rounded-card border border-border bg-surface p-5 text-sm text-muted-foreground">{page === 1 ? "No completed or cancelled court activity matches your filters." : "No booking history on this page."}</p>}
    {selected && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId} onClose={() => {
        if (selected.kind === "booking") router.replace(activityHref("history", query), { scroll: false });
        setSelected(null); returnFocusRef.current?.focus();
      }}
        className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50">
        <DialogHeader titleId={titleId} title={selected.kind === "booking" ? "Booking details" : "Reservation details"} status={historyStatus(selected)} statusTone={historyTone(selected)} onClose={() => dialogRef.current?.close()} />
        {selected.kind === "reservation" ? <ReservationDetails reservation={selected} /> :
          <><BookingDetails booking={selected} /><BookingPayment bookingId={selected.id} /></>}
        <DialogFooter><button type="button" onClick={() => dialogRef.current?.close()}
          className="min-h-10 rounded-control border border-border-strong px-4 text-sm font-semibold">Close</button></DialogFooter>
      </ModalDialog>, document.body)}
  </>;
}
