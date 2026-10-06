import type { RefundStatus } from "./refunds";

export function cancelledBookingMessage(status?: RefundStatus) {
  if (status === "succeeded") return "Booking cancelled. Your full payment has been refunded.";
  if (status === "failed") return "Booking cancelled. The full refund could not be completed; please contact the club.";
  if (status) return "Booking cancelled. Your full refund has been requested and is awaiting completion.";
  return "Booking cancelled.";
}
