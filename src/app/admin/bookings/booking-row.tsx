"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminBookingListItem } from "@/lib/bookings/admin-details";
import { bookingCreatedLabel, bookingStatusLabels, bookingStatusTones } from "@/lib/bookings/admin-query";
import { bookingTypeDetail, bookingTypeLabel } from "@/lib/bookings/booking-type";
import { formatMoney } from "@/lib/pricing/money";

export function BookingRow({ booking: b, listQuery, mobile = false }: { booking: AdminBookingListItem; listQuery: string; mobile?: boolean }) {
  const router = useRouter();
  const href = `/admin/bookings/${b.id}${listQuery ? `?${listQuery}` : ""}`;
  const rowProps = {
    tabIndex: 0,
    "aria-label": `Booking ${b.id.slice(0, 8)} for ${b.customer_name}`,
    onClick: (event: React.MouseEvent) => { if (!(event.target instanceof Element && event.target.closest("a"))) router.push(href); },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); router.push(href); }
    },
  };
  const hover = "cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  const reference = <Link href={href} className="font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">#{b.id.slice(0, 8)}</Link>;
  const status = <StatusBadge tone={bookingStatusTones[b.status]}>{bookingStatusLabels[b.status]}</StatusBadge>;
  const total = formatMoney(b.total_amount_minor, b.currency);
  const date = reservationDateLabel(b.booking_date), time = `${minuteToTime(b.starts_at_minute)}–${minuteToTime(b.ends_at_minute)}`;
  const typeDetail = bookingTypeDetail(b);
  const type = <><span className="block">{bookingTypeLabel(b)}</span>
    {typeDetail && <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{typeDetail}</span>}</>;
  const guest = !b.account_user_id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">Guest</span>;
  return mobile ? <li {...rowProps} className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
    <div className="flex items-start justify-between gap-3">{reference}{status}</div>
    <p className="mt-2 font-semibold text-foreground [overflow-wrap:anywhere]">{b.customer_name}{guest}</p>
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{b.customer_email}</p>
    <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-xs text-muted-foreground">Type</dt><dd className="min-w-0">{type}</dd>
      <dt className="text-xs text-muted-foreground">Court</dt><dd>{b.location_name} · {b.court_name}</dd>
      <dt className="text-xs text-muted-foreground">Scheduled</dt><dd>{date}, {time}</dd>
      <dt className="text-xs text-muted-foreground">Total</dt><dd className="font-semibold tabular-nums">{total}</dd>
      <dt className="text-xs text-muted-foreground">Created</dt><dd>{bookingCreatedLabel(b.created_at, b.location_timezone)}</dd>
    </dl>
  </li> : <tr {...rowProps} className={`${hover} [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top`}>
    <td>{reference}</td>
    <td className="w-48 min-w-40 max-w-48">{type}</td>
    <td className="[overflow-wrap:anywhere]"><span className="block font-medium">{b.customer_name}{guest}</span>
      <span className="block text-xs text-muted-foreground">{b.customer_email}</span></td>
    <td><span className="block">{b.location_name}</span><span className="block text-xs text-muted-foreground">{b.court_name}</span></td>
    <td className="whitespace-nowrap"><span className="block">{date}</span><span className="block text-xs text-muted-foreground">{time}</span></td>
    <td>{status}</td>
    <td className="whitespace-nowrap text-right font-semibold tabular-nums">{total}</td>
    <td className="whitespace-nowrap text-muted-foreground">{bookingCreatedLabel(b.created_at, b.location_timezone)}</td>
  </tr>;
}
