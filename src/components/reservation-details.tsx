import type { ReactNode } from "react";
import { DetailSection } from "@/components/dialog-layout";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";

export type ReservationDetailFields = {
  location_name: string; location_timezone: string; court_name: string; booking_date: string;
  starts_at_minute: number; ends_at_minute: number; reason: string | null;
};

export function reservationDateLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

export function ReservationDetailsView({ reservation, children }: { reservation: ReservationDetailFields; children: ReactNode }) {
  return <>
    <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={reservation} /></DetailSection>
    <DetailSection title="Reservation record">
      <dt className="text-muted-foreground">Reason</dt><dd>{reservation.reason || "Not recorded"}</dd>
      {children}
    </DetailSection>
  </>;
}

export function ReservationScheduleFieldsView({ reservation }: { reservation: Omit<ReservationDetailFields, "reason"> }) {
  return <>
    <dt className="text-muted-foreground">Location</dt><dd>{reservation.location_name}</dd>
    <dt className="text-muted-foreground">Court</dt><dd>{reservation.court_name}</dd>
    <dt className="text-muted-foreground">Date</dt><dd>{reservationDateLabel(reservation.booking_date)}</dd>
    <dt className="text-muted-foreground">Time</dt><dd>{minuteToTime(reservation.starts_at_minute)}–{minuteToTime(reservation.ends_at_minute)} ({reservation.location_timezone})</dd>
    <dt className="text-muted-foreground">Duration</dt><dd>{reservation.ends_at_minute - reservation.starts_at_minute} min</dd>
  </>;
}
