import type { PaymentMethod, PaymentProvider } from "./domain";
import type { RefundStatus } from "./refunds";

export type RefundPaymentFact = {
  id: string;
  method: PaymentMethod;
  provider: PaymentProvider | null;
  providerPaymentId: string | null;
  // The processing request amount is not itself evidence of collection.
  amountMinor: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "cancelled" | "expired" | "due";
  createdAt: Date;
};

export type RefundObligationFact = {
  id: string;
  paymentAttemptId: string;
  operationKey: string;
  amountMinor: number;
  status: RefundStatus;
};

export type CaptureReceiptFact = {
  paymentAttemptId: string;
  provider: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
};

type CaptureRequest = {
  id: string; method: string; provider: string | null; providerPaymentId: string | null;
  amountMinor: number; currency: string; status: string;
};

// Existing successful settlement is authoritative; terminal local attempts can
// also have an exact verified late-capture receipt. Mismatches remain manual.
export function verifiedCapturedAmount(payment: CaptureRequest, captures: readonly CaptureReceiptFact[]): number | null {
  if (payment.method !== "online" || payment.provider !== "stripe" || !payment.providerPaymentId) return null;
  const matching = captures.filter(capture => capture.paymentAttemptId === payment.id
    && capture.provider === payment.provider && capture.providerPaymentId === payment.providerPaymentId
    && capture.currency === payment.currency);
  const amount = matching.reduce((sum, capture) => sum + capture.amountMinor, 0);
  return matching.length && amount === payment.amountMinor ? amount : null;
}

export function refundObligationTotal(refunds: readonly Pick<RefundObligationFact, "amountMinor">[]): number {
  return refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
}

export function summarizeBookingFinancials<P extends RefundPaymentFact, R extends RefundObligationFact>(
  payments: P[], refunds: R[],
) {
  // Keep existing booking summaries scoped to successfully settled attempts.
  // Late-capture receipts are supplied explicitly to allocation/reconciliation.
  const captures = payments.filter(payment => payment.method === "online" && payment.status === "succeeded");
  const captured = captures.reduce((sum, payment) => sum + payment.amountMinor, 0);
  const refunded = refundObligationTotal(refunds.filter(refund => refund.status === "succeeded"));
  const obligated = refundObligationTotal(refunds);
  return { payments, refunds, captures, captured, refunded, obligated,
    netPaid: captured - refunded, refundable: captured - obligated };
}

export type RefundAllocation = {
  paymentAttemptId: string;
  provider: "stripe";
  providerPaymentId: string;
  amountMinor: number;
  capturedAmountMinor: number;
  currency: string;
};

export class RefundAllocationError extends Error {
  constructor(readonly reason: "invalid_amount" | "insufficient_funds" | "inconsistent_obligations") {
    super(reason === "invalid_amount" ? "Invalid refund amount"
      : reason === "insufficient_funds" ? "Insufficient unrefunded captured funds" : "Refund obligations exceed captured funds");
  }
}

export function allocateRefund(input: {
  payments: readonly RefundPaymentFact[];
  refunds: readonly RefundObligationFact[];
  captures: readonly CaptureReceiptFact[];
  operationKey: string;
  amount: number;
  onlyAttemptId?: string;
}): { kind: "replay"; refundIds: string[] } | { kind: "allocate"; allocations: RefundAllocation[] } {
  const existing = input.refunds.filter(refund => refund.operationKey === input.operationKey
    && (!input.onlyAttemptId || refund.paymentAttemptId === input.onlyAttemptId));
  if (existing.length) return { kind: "replay", refundIds: existing.map(refund => refund.id) };

  const balances = input.payments.filter(payment => !input.onlyAttemptId || payment.id === input.onlyAttemptId)
    .map(payment => ({ payment, captured: verifiedCapturedAmount(payment, input.captures) }))
    .filter((balance): balance is { payment: RefundPaymentFact & { providerPaymentId: string }; captured: number } =>
      balance.captured !== null && balance.payment.providerPaymentId !== null)
    .sort((a, b) => b.payment.createdAt.getTime() - a.payment.createdAt.getTime() || a.payment.id.localeCompare(b.payment.id))
    .map(({ payment, captured }) => ({ payment, captured, remaining: captured - refundObligationTotal(input.refunds
      .filter(refund => refund.paymentAttemptId === payment.id)) }));
  if (balances.some(balance => balance.remaining < 0)) throw new RefundAllocationError("inconsistent_obligations");
  const available = balances.reduce((sum, balance) => sum + balance.remaining, 0);
  let left = input.amount;
  if (!Number.isSafeInteger(left) || left < 0) throw new RefundAllocationError("invalid_amount");
  if (left > available) throw new RefundAllocationError("insufficient_funds");
  const allocations: RefundAllocation[] = [];
  for (const { payment, captured, remaining } of balances) {
    const amountMinor = Math.min(left, remaining);
    if (amountMinor === 0) continue;
    allocations.push({ paymentAttemptId: payment.id, provider: "stripe", providerPaymentId: payment.providerPaymentId,
      amountMinor, capturedAmountMinor: captured, currency: payment.currency });
    left -= amountMinor;
  }
  return { kind: "allocate", allocations };
}
