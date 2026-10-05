import { localMinute, localToday } from "@/lib/courts/local-time";

export type PersonalReservation = {
  id: string; court_id: string; location_id: string; updated_at: string;
  booking_date: string; starts_at_minute: number; ends_at_minute: number;
  reason: string | null; status: "active" | "cancelled";
  created_by_user_id: string | null; creator_name: string | null;
  cancelled_at: string | null; cancelled_by_name: string | null;
  location_name: string; location_timezone: string; court_name: string;
};

type ReservationClockFields = Pick<PersonalReservation, "booking_date" | "starts_at_minute" | "ends_at_minute" | "location_timezone">;

export function isReservationInProgress(row: ReservationClockFields, now: Date) {
  return row.booking_date === localToday(row.location_timezone, now)
    && row.starts_at_minute <= localMinute(row.location_timezone, now)
    && row.ends_at_minute > localMinute(row.location_timezone, now);
}

export function isReservationUpcoming(row: ReservationClockFields & Pick<PersonalReservation, "status">, now: Date) {
  const today = localToday(row.location_timezone, now);
  return row.status === "active" && (row.booking_date > today
    || row.booking_date === today && row.ends_at_minute > localMinute(row.location_timezone, now));
}

export function isReservationBeforeStart(row: ReservationClockFields, now: Date) {
  const today = localToday(row.location_timezone, now);
  return row.booking_date > today
    || row.booking_date === today && row.starts_at_minute > localMinute(row.location_timezone, now);
}
