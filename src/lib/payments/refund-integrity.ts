import { verifiedCapturedAmount } from "./refund-allocation";
import type { ProcessingRefund } from "@/lib/db/repositories/payments.repository";
import type { PaymentCaptureReceiptEntity } from "@/lib/db/entities/payment-capture-receipt.entity";

type OriginalPayment = {
  id: string; booking_id: string; method: string; provider: string | null;
  provider_payment_id: string | null; amount_minor: number; currency: string; status: string;
};
export function refundFinancialSnapshotMatches(refund: ProcessingRefund, payment: OriginalPayment): boolean {
  return refund.booking_id === payment.booking_id && refund.payment_attempt_id === payment.id
    && refund.provider === payment.provider && refund.provider_payment_id === payment.provider_payment_id
    && Number.isSafeInteger(refund.captured_amount_minor) && refund.captured_amount_minor > 0
    && refund.captured_amount_minor === payment.amount_minor && refund.amount_minor <= refund.captured_amount_minor
    && refund.currency === payment.currency;
}
export function paymentHasCapturedEvidence(payment: OriginalPayment, captures: readonly PaymentCaptureReceiptEntity[]): boolean {
  return verifiedCapturedAmount({ id: payment.id, method: payment.method, provider: payment.provider,
    providerPaymentId: payment.provider_payment_id, amountMinor: payment.amount_minor,
    currency: payment.currency, status: payment.status }, captures) !== null;
}
export function sameRefundSnapshot(a: ProcessingRefund, b: ProcessingRefund): boolean {
  return a.id === b.id && a.booking_id === b.booking_id && a.payment_attempt_id === b.payment_attempt_id
    && a.provider === b.provider && a.provider_payment_id === b.provider_payment_id
    && a.captured_amount_minor === b.captured_amount_minor && a.amount_minor === b.amount_minor && a.currency === b.currency && a.created_at === b.created_at;
}
