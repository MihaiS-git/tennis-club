import type { LocationCurrency } from "@/lib/pricing/money";

export type PersonalCustomerBooking = {
  id: string;
  booking_date: string;
  starts_at_minute: number;
  ends_at_minute: number;
  location_name: string;
  location_timezone: string;
  court_name: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  total_amount_minor: number;
  currency: LocationCurrency;
};
