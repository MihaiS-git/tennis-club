import type { LocationCurrency } from "@/lib/pricing/money";

export type PersonalCustomerBooking = {
  id: string;
  starts_at_instant: string;
  booking_date: string;
  starts_at_minute: number;
  ends_at_minute: number;
  location_name: string;
  location_timezone: string;
  court_name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  cancellation_notice_minutes: number;
  total_amount_minor: number;
  currency: LocationCurrency;
  // A modification payment is still processing; Edit stays hidden until it resolves.
  payment_pending?: boolean;
  // A requested cancellation or price reduction awaits its verified refund. The
  // booking remains confirmed; Edit and Cancel stay hidden until it resolves.
  pending_change?: "cancellation" | "reschedule";
};

// Upcoming bookings are confirmed. A pending refund-backed change outranks a
// processing modification payment because Edit and Cancel are both withheld.
export function upcomingBookingStatus(booking: Pick<PersonalCustomerBooking, "payment_pending" | "pending_change">) {
  if (booking.pending_change === "cancellation") return { label: "Cancellation pending", tone: "warning" } as const;
  if (booking.pending_change === "reschedule") return { label: "Modification pending", tone: "warning" } as const;
  if (booking.payment_pending) return { label: "Payment processing", tone: "warning" } as const;
  return { label: "Confirmed", tone: "success" } as const;
}

// Customer-safe payment summary. Carries no provider, attempt or refund identifiers.
export type OwnBookingPaymentOperation = {
  kind: "payment" | "refund"; label: string; amount: number; state: "completed" | "pending" | "failed"; at: string | null;
};
export type OwnBookingPayment = {
  method: "online" | "pay_at_club"; currency: LocationCurrency; timezone: string;
  total: number; paid: number; refunded: number; refundPending: number; outstanding: number; dueAtClub: number;
  operations: OwnBookingPaymentOperation[];
};
