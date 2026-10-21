import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { DetailSection } from "@/components/dialog-layout";
import { ReservationScheduleFieldsView } from "@/components/reservation-details";
import { StatusBadge } from "@/components/status-badge";
import { adminListTypeLabels, bookingCreatedLabel, reservationStatusLabels, reservationStatusTones } from "@/lib/bookings/admin-query";
import type { AdminDirectReservationDetails } from "@/lib/reservations/service";
import { CopyBookingId } from "../../[bookingId]/copy-booking-id";
import { ReservationActions } from "./reservation-actions";

// Free staff reservations are separate records from customer bookings: no customer,
// price, payment or refund. Cancelled reservations stay visible with who cancelled them.
// Admins manage any staff reservation; a Coach sees only their own, with owner actions.
export function ReservationRecord({ details, back, scope }: {
  details: AdminDirectReservationDetails; back: { href: string; label: string }; scope: "admin" | "owner";
}) {
  const { reservation: r } = details;
  const creator = r.creator_name || "Unknown creator";
  return <>
    <Link href={back.href} className="mb-4 inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
      <ArrowLeft size={16} aria-hidden />{back.label}
    </Link>
    <AdminPageHeader title={`Reservation #${r.id.slice(0, 8)}`} description={<>
      Created {bookingCreatedLabel(r.created_at, r.location_timezone)} ({r.location_timezone})
    </>}>
      <StatusBadge tone={reservationStatusTones[r.status]}>{reservationStatusLabels[r.status]}</StatusBadge>
    </AdminPageHeader>
    <ReservationActions reservation={{ id: r.id, court_id: r.court_id, booking_date: r.booking_date,
      starts_at_minute: r.starts_at_minute, ends_at_minute: r.ends_at_minute, reason: r.reason,
      location_name: r.location_name, location_timezone: r.location_timezone, court_name: r.court_name }}
      creatorName={creator} startsAt={details.startsAt} endsAt={details.endsAt} started={details.started}
      editable={details.editable} cancellable={details.cancellable} scope={scope} />
    <div className="grid max-w-4xl gap-x-8 rounded-card border border-border bg-surface p-5 pt-1 md:grid-cols-2">
      <DetailSection title="Reservation identity">
        <dt className="text-muted-foreground">Type</dt><dd>{adminListTypeLabels.reservation}</dd>
        <dt className="text-muted-foreground">Reservation ID</dt>
        <dd className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs [overflow-wrap:anywhere]">{r.id}</code>
          <CopyBookingId id={r.id} noun="reservation" /></dd>
        <dt className="text-muted-foreground">Status</dt><dd>{reservationStatusLabels[r.status]}</dd>
        <dt className="text-muted-foreground">Reason</dt><dd>{r.reason || "Not recorded"}</dd>
        <dt className="text-muted-foreground">Created</dt><dd>{bookingCreatedLabel(r.created_at, r.location_timezone)}</dd>
        {r.cancelled_at && <><dt className="text-muted-foreground">Cancelled</dt>
          <dd>{bookingCreatedLabel(r.cancelled_at, r.location_timezone)}{r.canceller_name ? ` by ${r.canceller_name}` : ""}</dd></>}
      </DetailSection>
      <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={r} /></DetailSection>
      <DetailSection title="Created by">
        <dt className="text-muted-foreground">Name</dt><dd>{creator}</dd>
        {r.creator_email && <><dt className="text-muted-foreground">Email</dt><dd>{r.creator_email}</dd></>}
        {r.creator_phone && <><dt className="text-muted-foreground">Phone</dt><dd>{r.creator_phone}</dd></>}
        {scope === "admin" && <><dt className="text-muted-foreground">Account</dt>
          <dd><Link href={`/admin/users/${r.created_by_user_id}`} className="text-primary underline focus-visible:outline-2 focus-visible:outline-focus">View user account</Link></dd></>}
      </DetailSection>
    </div>
  </>;
}
