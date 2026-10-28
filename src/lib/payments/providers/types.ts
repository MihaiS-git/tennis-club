import "server-only";

import type { PaymentProvider, PaymentPresentation } from "../domain";

export interface PaymentProviderConfiguration {
  readonly id: PaymentProvider;
  isConfigured(): boolean;
}

export interface OnlinePaymentAdapter {
  resumePayment(attempt: { id: string; providerPaymentId: string }): Promise<import("../domain").OnlineCheckout["presentation"]>;
  readPayment(attempt: { id: string; providerPaymentId: string }): Promise<{
    // authorized: funds held for a manual-capture payment; nothing is collected
    // until the server captures it.
    status: "pending" | "processing" | "authorized" | "succeeded" | "cancelled";
    amountMinor: number; currency: string; providerCaptureId: string | null;
    // Only a submitted payment that can still succeed without the customer.
    live?: boolean;
  }>;
  refundPayment(refund: { id: string; executionId: string; idempotencyKey: string; providerPaymentId: string; amountMinor: number; currency: string;
    // recover: find only. replay: find, then re-send the stored request with its
    // exact idempotency key (inside the provider's key retention window).
    providerRefundId: string | null; dispatchInitiatedAt?: string; operation: "create" | "recover" | "replay" }): Promise<RefundProviderResult>;

  cancelPayment(attempt: { id: string; providerPaymentId: string }): Promise<"cancelled" | "succeeded" | "processing">;
  // Collects an authorized manual-capture payment. Throws when the outcome is unknown.
  capturePayment(attempt: { id: string; providerPaymentId: string }): Promise<{
    status: "succeeded" | "cancelled"; amountMinor: number; currency: string; providerCaptureId: string | null }>;
  // Dismissal never cancels a live payment; anything still awaiting the
  // customer (including authentication) is cancelled. Navigation's unusedOnly
  // mode additionally preserves authentication and uncaptured authorizations.
  dismissPayment(attempt: { id: string; providerPaymentId: string; unusedOnly?: boolean }): Promise<"cancelled" | "succeeded" | "live">;
  // Authorizes only (manual capture); the server captures after verifying the
  // checkout or modification deadline.
  createPayment(attempt: { id: string; amountMinor: number; currency: string }): Promise<{
    providerPaymentId: string;
    presentation: PaymentPresentation;
  }>;
}

// A verified signal that a submitted payment is in flight. It never settles anything.
export type OnlinePaymentProcessing = { provider: PaymentProvider; attemptId: string; providerPaymentId: string; outcome: "processing" };
// A verified signal that a manual-capture payment is authorized. It never settles
// anything: the server re-reads the payment and decides capture or cancellation.
export type OnlinePaymentAuthorized = { provider: PaymentProvider; attemptId: string; providerPaymentId: string; outcome: "authorized" };
// A verified signal that a provider refund changed. It carries no result: the
// refund is re-read from the provider and committed by the refund service.
export type OnlineRefundChanged = { provider: PaymentProvider; refundId: string; outcome: "refund_changed" };

export type OnlinePaymentEvent = {
  provider: PaymentProvider; eventId: string; attemptId: string; providerPaymentId: string;
  outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled"; amountMinor: number; currency: string;
  providerCaptureId?: string;
};

type RefundProviderResult = { providerRefundId: string; status: "succeeded" | "pending" | "failed"; retryable?: boolean; failureReason?: string };

export type RefundProviderFailure =
  | { kind: "request_rejected"; retryable?: boolean; failureReason?: string; operation: "create"; providerRefundId: null }
  | { kind: "uncertain"; operation: "create"; providerRefundId: null }
  | { kind: "lookup_failed"; operation: "discover" | "retrieve"; providerRefundId: string | null }
  | { kind: "not_found"; operation: "discover"; providerRefundId: null }
  | { kind: "evidence_mismatch"; operation: "discover" | "retrieve" | "create"; providerRefundId: string };

export class RefundProviderError extends Error {
  constructor(readonly evidence: RefundProviderFailure) { super("Payment service unavailable."); }
}
