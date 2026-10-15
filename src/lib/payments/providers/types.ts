import "server-only";

import type { PaymentProvider, PaymentPresentation } from "../domain";

export interface PaymentProviderConfiguration {
  readonly id: PaymentProvider;
  isConfigured(): boolean;
}

export interface OnlinePaymentAdapter {
  resumePayment(attempt: { id: string; providerPaymentId: string }): Promise<import("../domain").OnlineCheckout["presentation"]>;
  readPayment(attempt: { id: string; providerPaymentId: string }): Promise<{
    status: "pending" | "processing" | "succeeded" | "cancelled";
    amountMinor: number; currency: string; providerCaptureId: string | null;
  }>;
  refundPayment(refund: { id: string; executionId: string; idempotencyKey: string; providerPaymentId: string; amountMinor: number; currency: string;
    providerRefundId: string | null; operation: "create" | "recover" }): Promise<RefundProviderResult>;

  cancelPayment(attempt: { id: string; providerPaymentId: string }): Promise<"cancelled" | "succeeded" | "processing">;
  createPayment(attempt: { id: string; amountMinor: number; currency: string }): Promise<{
    providerPaymentId: string;
    presentation: PaymentPresentation;
  }>;
}

export type OnlinePaymentEvent = {
  provider: PaymentProvider; eventId: string; attemptId: string; providerPaymentId: string;
  outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled"; amountMinor: number; currency: string;
  providerCaptureId?: string;
};

type RefundProviderResult = { providerRefundId: string; status: "succeeded" | "pending" | "failed" };

export type RefundProviderFailure =
  | { kind: "request_rejected"; operation: "create"; providerRefundId: null }
  | { kind: "uncertain"; operation: "create"; providerRefundId: null }
  | { kind: "lookup_failed"; operation: "discover" | "retrieve"; providerRefundId: string | null }
  | { kind: "not_found"; operation: "discover"; providerRefundId: null }
  | { kind: "evidence_mismatch"; operation: "discover" | "retrieve" | "create"; providerRefundId: string };

export class RefundProviderError extends Error {
  constructor(readonly evidence: RefundProviderFailure) { super("Payment service unavailable."); }
}
