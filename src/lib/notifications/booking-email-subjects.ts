import type { BookingEmailEvent } from "./booking-email";

// The fixed subject of each booking email. Customer and Admin cancellations share one.
export const bookingEmailSubjects: Record<BookingEmailEvent["event_kind"], string> = {
  confirmed: "Booking confirmed", customer_cancelled: "Booking cancelled", admin_cancelled: "Booking cancelled",
  customer_rescheduled: "Booking rescheduled", cancellation_failed: "Booking cancellation not completed",
  modification_failed: "Booking change not completed", refund_incomplete: "Refund requires attention",
  late_payment_refund: "Payment received after checkout ended",
};
