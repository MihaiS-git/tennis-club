import type { ProcessingRefund, ProviderReceipt } from "@/lib/db/repositories/payments.repository";

type OriginalPayment = {
  id: string; booking_id: string; method: string; provider: string | null;
  provider_payment_id: string | null; amount_minor: number; currency: string; status: string;
};
export function refundFinancialSnapshotMatches(refund: ProcessingRefund, payment: OriginalPayment): boolean {
  return refund.booking_id === payment.booking_id && refund.payment_attempt_id === payment.id
    && refund.provider === payment.provider && refund.provider_payment_id === payment.provider_payment_id
    && refund.amount_minor === payment.amount_minor && refund.currency === payment.currency;
}
export function paymentHasCapturedEvidence(payment: OriginalPayment, events: readonly ProviderReceipt[]): boolean {
  return payment.method === "online" && payment.provider === "stripe" && !!payment.provider_payment_id
    && (payment.status === "succeeded" || events.some(event => event.attempt_id === payment.id
      && event.provider === payment.provider && event.provider_payment_id === payment.provider_payment_id
      && event.outcome === "succeeded" && event.amount_minor === payment.amount_minor && event.currency === payment.currency));
}
export function sameRefundSnapshot(a: ProcessingRefund, b: ProcessingRefund): boolean {
  return a.id === b.id && a.booking_id === b.booking_id && a.payment_attempt_id === b.payment_attempt_id
    && a.provider === b.provider && a.provider_payment_id === b.provider_payment_id
    && a.amount_minor === b.amount_minor && a.currency === b.currency && a.created_at === b.created_at;
}
