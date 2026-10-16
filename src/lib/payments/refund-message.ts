import type { RefundStatus } from "./refunds";

type CancellationOutcome = { outcome: "cancelled"; refundStatus?: RefundStatus } | { outcome: "cancellation_pending" };

export function cancelledBookingMessage(result: CancellationOutcome) {
  if (result.outcome === "cancellation_pending")
    return "Cancellation requested. The booking stays confirmed until the refund is confirmed; you will be emailed if it cannot be completed.";
  const status = result.refundStatus;
  if (status === "succeeded") return "Booking cancelled. Your payment has been refunded.";
  if (status === "failed") return "Booking cancelled. Part of the refund could not be completed; the club will contact you.";
  if (status) return "Booking cancelled. Your refund has been requested; you will be emailed if it cannot be completed.";
  return "Booking cancelled.";
}
