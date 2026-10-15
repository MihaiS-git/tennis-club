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
