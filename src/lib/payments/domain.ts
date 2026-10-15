import { z } from "zod";
import { timestampToEpochMicroseconds } from "@/lib/precise-time";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { RefundStatus } from "./refunds";

export const paymentMethodSchema = z.enum(["online", "pay_at_club"]);
export const paymentProviderSchema = z.enum(["stripe", "netopia"]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;
export const paymentHoldDurationSeconds = 10 * 60;
// Test-only shortening for lifecycle verification. Production always uses the
// constant: the override is ignored unless NODE_ENV is "test" or the explicit
// E2E flag is set, and never when NODE_ENV is "production".
export function paymentHoldSeconds(env: Record<string, string | undefined> = process.env) {
  const override = env.BOOKING_HOLD_SECONDS_OVERRIDE;
  if (!override || env.NODE_ENV === "production"
    || (env.NODE_ENV !== "test" && env.E2E_ALLOW_HOLD_OVERRIDE !== "1")) return paymentHoldDurationSeconds;
  const seconds = z.coerce.number().int().min(15).max(paymentHoldDurationSeconds).safeParse(override);
  return seconds.success ? seconds.data : paymentHoldDurationSeconds;
}
export function checkoutPersistence(method: PaymentMethod) {
  const online = method === "online";
  return { booking_status: online ? "pending_payment" : "confirmed", reservation_status: online ? "held" : "active",
    attempt_status: online ? "pending" : "due", hold_seconds: online ? paymentHoldDurationSeconds : null } as const;
}
// Routine uncertainty is retried automatically. Attention means money that the
// automation cannot return (definitive failure), recovery stalled beyond the
// provider idempotency window, or captured evidence needing investigation.
export const attentionRefundStatuses = ["failed"];
export const stalledRefundHours = 24;
export function refundRecoveryStalled(status: string | null | undefined, recoveryStartedAt: string | null | undefined, now = Date.now()) {
  return status === "pending_retry" && !!recoveryStartedAt && now - Date.parse(recoveryStartedAt) > stalledRefundHours * 3_600_000;
}
export function summarizeRefunds(statuses: RefundStatus[]): RefundStatus | undefined {
  const active = statuses.filter(status => status !== "voided");
  return active.includes("failed") ? "failed" : active.includes("pending_retry") ? "pending_retry"
    : active.includes("pending") ? "pending" : active.length ? "succeeded" : undefined;
}
export function paymentNeedsAttention(refund: { status: string; recovery_started_at?: string | null } | null | undefined,
  events: readonly { reconciliation_required: boolean }[]) {
  return attentionRefundStatuses.includes(refund?.status ?? "") || refundRecoveryStalled(refund?.status, refund?.recovery_started_at)
    || events.some((event) => event.reconciliation_required);
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
const checkoutPaymentStatusSchema = z.enum(["pending", "processing", "unknown", "succeeded",
  "cancelled", "expired", "failed", "refund_pending", "refund_failed", "refunded"]);
export type CheckoutPaymentStatus = z.infer<typeof checkoutPaymentStatusSchema>;
export const checkoutStatusResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), message: z.string() }),
  z.object({ ok: z.literal(true), status: z.enum(["pending_payment", "confirmed", "expired", "failed", "cancelled", "completed"]),
    paymentStatus: checkoutPaymentStatusSchema, paymentUncertain: z.boolean(),
    totalAmountMinor: z.number().int().positive(), currency: z.enum(locationCurrencies),
    cancellationPolicy: z.object({ noticeMinutes: cancellationNoticeMinutesSchema, cutoff: z.string().nullable() }).nullable(),
  }),
]);

export function paymentTransition(input: {
  attemptStatus: string; bookingStatus: string; reservationStatus: string;
  reservationExpiry: string | null; attemptExpiry: string | null; now: string;
  outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled";
}) {
  if (input.attemptStatus !== "pending") return { result: input.attemptStatus, targets: null, deadline: null };
  // Booking cancellation intent is durable even while Stripe is uncertain.
  // Never turn a later capture into a booking confirmation.
  if (input.bookingStatus === "cancelled" && ["held", "released"].includes(input.reservationStatus)) {
    if (input.outcome === "retryable_failed") return { result: "pending", targets: null, deadline: null };
    return { result: input.outcome, deadline: null, targets: {
      attempt: input.outcome, booking: "cancelled", reservation: "released",
    } };
  }
  if (input.bookingStatus !== "pending_payment" || input.reservationStatus !== "held")
    return { result: "unavailable", targets: null, deadline: null };
  if (input.reservationExpiry === null || input.attemptExpiry === null) throw new Error("Payment hold deadline missing.");
  const deadlineValue = timestampToEpochMicroseconds(input.reservationExpiry) <= timestampToEpochMicroseconds(input.attemptExpiry)
    ? input.reservationExpiry : input.attemptExpiry;
  const expired = timestampToEpochMicroseconds(deadlineValue) <= timestampToEpochMicroseconds(input.now);
  const outcome = expired ? "expired" : input.outcome;
  const deadline = expired ? null : deadlineValue;
  if (outcome === "retryable_failed") return { result: "pending", targets: null, deadline };
  return { result: outcome, deadline, targets: {
    attempt: input.outcome === "cancelled" ? "cancelled" : outcome,
    booking: outcome === "succeeded" ? "confirmed" : outcome === "failed" ? "failed" : "expired",
    reservation: outcome === "succeeded" ? "active" : "released",
  } };
}
