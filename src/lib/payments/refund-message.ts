import type { RefundStatus } from "./refunds";

type CancellationOutcome = { outcome: "cancelled"; refundStatus?: RefundStatus } | { outcome: "cancellation_pending" };

// Admin cancels on the customer's behalf, so its wording refers to the customer.
export function cancelledBookingMessage(result: CancellationOutcome, audience: "customer" | "admin" = "customer") {
  if (result.outcome === "cancellation_pending")
    return "Cancellation requested. The booking stays confirmed until the refund is confirmed.";
  const status = result.refundStatus;
  const admin = audience === "admin";
  if (status === "succeeded") return admin ? "Booking cancelled. The customer's payment has been refunded."
    : "Booking cancelled. Your payment has been refunded.";
  if (status === "failed") return admin ? "Booking cancelled. Part of the refund could not be completed; review the booking's financial history."
    : "Booking cancelled. Part of the refund could not be completed; the club will contact you.";
  if (status) return admin ? "Booking cancelled. The customer's refund has been requested." : "Booking cancelled. Your refund has been requested.";
  return "Booking cancelled.";
}
