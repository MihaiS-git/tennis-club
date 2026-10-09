import "server-only";

import type { PaymentProvider, PaymentPresentation } from "../domain";

export interface PaymentProviderConfiguration {
  readonly id: PaymentProvider;
  isConfigured(): boolean;
}

export interface OnlinePaymentAdapter {
  refundPayment(refund: { id: string; providerPaymentId: string; amountMinor: number; currency: string;
    providerRefundId: string | null }): Promise<{ providerRefundId: string; status: "succeeded" | "pending" | "failed" }>;

  cancelPayment(attempt: { id: string; providerPaymentId: string }): Promise<"cancelled" | "succeeded" | "processing">;
  createPayment(attempt: { id: string; amountMinor: number; currency: string }): Promise<{
    providerPaymentId: string;
    presentation: PaymentPresentation;
  }>;
}

export type OnlinePaymentEvent = {
  provider: PaymentProvider; eventId: string; attemptId: string; providerPaymentId: string;
  outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled"; amountMinor: number; currency: string;
};

export class RefundProviderError extends Error {
  constructor(readonly retryable: boolean) { super("Payment service unavailable."); }
}
