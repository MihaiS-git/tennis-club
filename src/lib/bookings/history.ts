import type { LocationCurrency } from "@/lib/pricing/money";
import type { PersonalReservation } from "@/lib/reservations/personal";

export type CustomerBookingHistoryItem = {
  kind: "booking"; id: string; history_at: string;
  booking_date: string; starts_at_minute: number; ends_at_minute: number;
  location_name: string; location_timezone: string; court_name: string;
  status: "confirmed" | "cancelled";
  customer_name: string; customer_email: string; customer_phone: string;
  cancellation_notice_minutes: number;
  total_amount_minor: number; currency: LocationCurrency;
};

type DirectReservationHistoryItem = PersonalReservation & {
  kind: "reservation"; history_at: string;
};

export type CourtHistoryItem = CustomerBookingHistoryItem | DirectReservationHistoryItem;

export function historyStatus(item: CourtHistoryItem) {
  return item.status === "cancelled" ? "Cancelled" : "Completed";
}
