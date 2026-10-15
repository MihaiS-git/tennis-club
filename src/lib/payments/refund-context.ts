export const refundReasons = [
  "booking_cancellation",
  "booking_price_reduction",
  "failed_adjustment_compensation",
  "late_capture_compensation",
] as const;

export type RefundReason = typeof refundReasons[number];
