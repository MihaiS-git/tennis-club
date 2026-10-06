import { z } from "zod";

export const paymentMethodSchema = z.enum(["online", "pay_at_club"]);
export const paymentProviderSchema = z.enum(["stripe", "netopia"]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;
export const paymentHoldDurationSeconds = 10 * 60;
export function checkoutPersistence(method: PaymentMethod) {
  const online = method === "online";
  return { booking_status: online ? "pending_payment" : "confirmed", reservation_status: online ? "held" : "active",
    attempt_status: online ? "pending" : "due", hold_seconds: online ? paymentHoldDurationSeconds : null };
}
export const attentionRefundStatuses = ["pending_retry", "failed"];
export function paymentNeedsAttention(refundStatus: string | null | undefined, events: readonly { reconciliation_required: boolean }[]) {
  return attentionRefundStatuses.includes(refundStatus ?? "") || events.some((event) => event.reconciliation_required);
}
export type CheckoutLifecycle =
  | { status: "pending_payment"; holdExpiresAt: string }
  | { status: "confirmed"; holdExpiresAt: null };

// Safe presentation data only; provider credentials never belong in these types.
export type PaymentSettings = {
  activeProvider: PaymentProvider | null;
  providers: { id: PaymentProvider; configured: boolean }[];
};

export type PaymentPresentation = { kind: "stripe"; clientSecret: string; publishableKey: string };
export type OnlineCheckout = { attemptId: string; token: string; presentation: PaymentPresentation };

export function paymentTransition(input: {
  attemptStatus: string; bookingStatus: string; reservationStatus: string;
  reservationExpiry: string | null; attemptExpiry: string | null; now: string;
  outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled";
}) {
  if (input.attemptStatus !== "pending") return { result: input.attemptStatus, targets: null, deadline: null };
  if (input.bookingStatus !== "pending_payment" || input.reservationStatus !== "held")
    return { result: "unavailable", targets: null, deadline: null };
  const expiry = Math.min(Date.parse(input.reservationExpiry ?? ""), Date.parse(input.attemptExpiry ?? ""));
  const expired = expiry <= Date.parse(input.now);
  const outcome = expired ? "expired" : input.outcome;
  const deadline = expired ? null : new Date(expiry).toISOString();
  if (outcome === "retryable_failed") return { result: "pending", targets: null, deadline };
  return { result: outcome, deadline, targets: {
    attempt: input.outcome === "cancelled" ? "cancelled" : outcome,
    booking: outcome === "succeeded" ? "confirmed" : outcome === "failed" ? "failed" : "expired",
    reservation: outcome === "succeeded" ? "active" : "released",
  } };
}
