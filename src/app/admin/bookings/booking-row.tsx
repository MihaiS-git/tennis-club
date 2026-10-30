import { localStartInstant } from "@/lib/courts/local-time";
import { AdminBookingEdit } from "./admin-booking-editor";
import { CoachLessonCancellation } from "@/app/coach/bookings/lessons/[bookingId]/lesson-cancellation";
import { CoachLessonReschedule } from "@/app/coach/bookings/lessons/[bookingId]/lesson-reschedule";
import { RowLink } from "@/components/row-link";
import { StatusBadge } from "@/components/status-badge";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminBookingListItem } from "@/lib/bookings/admin-details";
import type { CoachBookingListItem } from "@/lib/bookings/coach-bookings";
import { adminListTypeLabels, bookingCreatedLabel, bookingStatusLabels, bookingStatusTones, reservationStatusLabels,
  reservationStatusTones } from "@/lib/bookings/admin-query";
import { bookingTypeDetail, bookingTypeLabel } from "@/lib/bookings/booking-type";
import { formatMoney } from "@/lib/pricing/money";

type ListItem<Kind> = Extract<AdminBookingListItem | CoachBookingListItem, { kind: Kind }>;
export type ListScope = "admin" | "coach";
// Coach rows carry no price or customer account and open the Coach details routes.
const detailBase = { admin: { booking: "/admin/bookings", reservation: "/admin/bookings/reservations" },
  coach: { booking: "/coach/bookings/lessons", reservation: "/coach/bookings/reservations" } };

export function BookingRow({ booking, listQuery, mobile = false, scope = "admin" }: {
  booking: AdminBookingListItem | CoachBookingListItem; listQuery: string; mobile?: boolean; scope?: ListScope;
}) {
  return booking.kind === "reservation" ? <ReservationRow reservation={booking} listQuery={listQuery} mobile={mobile} scope={scope} />
    : <CustomerBookingRow booking={booking} listQuery={listQuery} mobile={mobile} scope={scope} />;
}

const hover = "relative cursor-pointer hover:bg-surface-muted focus-within:bg-surface-muted";

function CustomerBookingRow({ booking: b, listQuery, mobile, scope }: { booking: ListItem<"booking">; listQuery: string; mobile: boolean; scope: ListScope }) {
  const editable = b.status === "confirmed";
  const href = `${detailBase[scope].booking}/${b.id}${listQuery ? `?${listQuery}` : ""}`;
  const reference = <RowLink href={href} className="font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">#{b.id.slice(0, 8)}</RowLink>;
  const status = <StatusBadge tone={bookingStatusTones[b.status]}>{bookingStatusLabels[b.status]}</StatusBadge>;
  const total = "total_amount_minor" in b ? formatMoney(b.total_amount_minor, b.currency) : null;
  const date = reservationDateLabel(b.booking_date), time = `${minuteToTime(b.starts_at_minute)}–${minuteToTime(b.ends_at_minute)}`;
  const typeDetail = bookingTypeDetail(b);
  const type = <><span className="block">{bookingTypeLabel(b)}</span>
    {typeDetail && <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{typeDetail}</span>}</>;
  const guest = "account_user_id" in b && !b.account_user_id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">Guest</span>;
  // The Coach's own lessons only (the List query scopes Coach rows).
  // Reschedule lesson is offered with Cancel lesson; the cancellation label explains any other state.
  const cancel = scope === "coach" && "cancellation" in b && b.cancellation.availability !== "unavailable"
    && <div className="flex items-center justify-end gap-2">
      <CoachLessonReschedule lesson={b} cancellation={b.cancellation} variant="icon" />
      <CoachLessonCancellation lesson={b} cancellation={b.cancellation} variant="icon" />
    </div>;
  return mobile ? <li className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
    <div className="flex items-start justify-between gap-3">{reference}{status}</div>
    <p className="mt-2 font-semibold text-foreground [overflow-wrap:anywhere]">{b.customer_name}{guest}</p>
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{b.customer_email}</p>
    <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-xs text-muted-foreground">Type</dt><dd className="min-w-0">{type}</dd>
      <dt className="text-xs text-muted-foreground">Court</dt><dd>{b.location_name} · {b.court_name}</dd>
      <dt className="text-xs text-muted-foreground">Scheduled</dt><dd>{date}, {time}</dd>
      {total && <><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-semibold tabular-nums">{total}</dd></>}
      <dt className="text-xs text-muted-foreground">Created</dt><dd>{bookingCreatedLabel(b.created_at, b.location_timezone)}</dd>
    </dl>
    {scope === "admin" && editable && <div className="relative z-10 mt-3"><AdminBookingEdit bookingId={b.id} startsAt={localStartInstant(b.location_timezone, b.booking_date, b.starts_at_minute)} /></div>}
    {cancel && <div className="mt-3">{cancel}</div>}
  </li> : <tr className={`${hover} [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top`}>
    <td>{reference}</td>
    <td className="w-48 min-w-40 max-w-48">{type}</td>
    <td className="[overflow-wrap:anywhere]"><span className="block font-medium">{b.customer_name}{guest}</span>
      <span className="block text-xs text-muted-foreground">{b.customer_email}</span></td>
    <td><span className="block">{b.location_name}</span><span className="block text-xs text-muted-foreground">{b.court_name}</span></td>
    <td className="whitespace-nowrap"><span className="block">{date}</span><span className="block text-xs text-muted-foreground">{time}</span></td>
    <td>{status}</td>
    {total && <td className="whitespace-nowrap text-right font-semibold tabular-nums">{total}</td>}
    <td className="whitespace-nowrap text-muted-foreground">{bookingCreatedLabel(b.created_at, b.location_timezone)}</td>
    {scope === "coach" ? <td>{cancel}</td> : <td className="relative z-10">{editable && <AdminBookingEdit bookingId={b.id} startsAt={localStartInstant(b.location_timezone, b.booking_date, b.starts_at_minute)} />}</td>}
  </tr>;
}

// Free operational records: no customer, price or payment, so Total shows none.
function ReservationRow({ reservation: r, listQuery, mobile, scope }: { reservation: ListItem<"reservation">; listQuery: string; mobile: boolean; scope: ListScope }) {
  const href = `${detailBase[scope].reservation}/${r.id}${listQuery ? `?${listQuery}` : ""}`;
  const creator = r.creator_name || "Unknown creator";
  const reference = <RowLink href={href} className="font-mono text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-focus">#{r.id.slice(0, 8)}</RowLink>;
  const status = <StatusBadge tone={reservationStatusTones[r.status]}>{reservationStatusLabels[r.status]}</StatusBadge>;
  const date = reservationDateLabel(r.booking_date), time = `${minuteToTime(r.starts_at_minute)}–${minuteToTime(r.ends_at_minute)}`;
  const type = <><span className="block">{adminListTypeLabels.reservation}</span>
    {r.reason && <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.reason}</span>}</>;
  const staff = <span className="ml-1.5 text-xs font-normal text-muted-foreground">Staff</span>;
  const total = <><span aria-hidden>—</span><span className="sr-only">No charge</span></>;
  return mobile ? <li className={`min-w-0 rounded-card border border-border bg-surface p-4 ${hover}`}>
    <div className="flex items-start justify-between gap-3">{reference}{status}</div>
    <p className="mt-2 font-semibold text-foreground [overflow-wrap:anywhere]">{creator}{staff}</p>
    {r.creator_email && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.creator_email}</p>}
    <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-xs text-muted-foreground">Type</dt><dd className="min-w-0">{type}</dd>
      <dt className="text-xs text-muted-foreground">Court</dt><dd>{r.location_name} · {r.court_name}</dd>
      <dt className="text-xs text-muted-foreground">Scheduled</dt><dd>{date}, {time}</dd>
      {scope === "admin" && <><dt className="text-xs text-muted-foreground">Total</dt><dd>{total}</dd></>}
      <dt className="text-xs text-muted-foreground">Created</dt><dd>{bookingCreatedLabel(r.created_at, r.location_timezone)}</dd>
    </dl>
  </li> : <tr className={`${hover} [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top`}>
    <td>{reference}</td>
    <td className="w-48 min-w-40 max-w-48">{type}</td>
    <td className="[overflow-wrap:anywhere]"><span className="block font-medium">{creator}{staff}</span>
      {r.creator_email && <span className="block text-xs text-muted-foreground">{r.creator_email}</span>}</td>
    <td><span className="block">{r.location_name}</span><span className="block text-xs text-muted-foreground">{r.court_name}</span></td>
    <td className="whitespace-nowrap"><span className="block">{date}</span><span className="block text-xs text-muted-foreground">{time}</span></td>
    <td>{status}</td>
    {scope === "admin" && <td className="whitespace-nowrap text-right text-muted-foreground">{total}</td>}
    <td className="whitespace-nowrap text-muted-foreground">{bookingCreatedLabel(r.created_at, r.location_timezone)}</td>
    <td />
  </tr>;
}
