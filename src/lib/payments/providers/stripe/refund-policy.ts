import type { z } from "zod";
import type { paymentFactSchema, providerEventFactSchema } from "@/lib/payments/facts";

type Payment = Omit<z.infer<typeof paymentFactSchema>, "created_at" | "expires_at">;
type Event = z.infer<typeof providerEventFactSchema>;
export function refundRetryEligible(status: string | null | undefined, provider: string | null) {
  return provider === "stripe" && (status === "pending_retry" || status === "failed");
}
export function successfulRefundPayment(payments: readonly z.infer<typeof paymentFactSchema>[]) {
  return [...payments].filter((p) => p.status === "succeeded" && p.method === "online" && p.provider === "stripe")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0] ?? null;
}
export function refundableLateCapture(event: Event, payment: Payment, bookingStatus: string, reservationStatus: string) {
  return event.provider === "stripe" && event.outcome === "succeeded"
    && ["expired", "cancelled", "failed"].includes(event.settlement_result)
    && payment.provider === "stripe" && payment.method === "online"
    && payment.id === event.attempt_id && payment.provider_payment_id === event.provider_payment_id
    && payment.amount_minor === event.amount_minor && payment.currency === event.currency
    && ["expired", "cancelled", "failed"].includes(payment.status)
    && ["expired", "failed", "cancelled"].includes(bookingStatus)
    && ["released", "cancelled"].includes(reservationStatus);
}
export function resolvableRefundEvents(context: { payments: readonly Payment[]; events: readonly Event[]; booking: { status: string }; reservation: { status: string } }, attemptId: string) {
  const payment = context.payments.find((p) => p.id === attemptId);
  return payment ? context.events.filter((e) => e.reconciliation_required
    && refundableLateCapture(e, payment, context.booking.status, context.reservation.status))
    .map((e) => ({ provider: e.provider, event_id: e.event_id })) : [];
}
