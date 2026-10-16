import "server-only";
import { z } from "zod";
import Stripe from "stripe";
import { RefundProviderError } from "../types";
import { stripeClient, StripeProviderError } from "./client";
import { stripeConfig } from "./config";
import type { OnlinePaymentAdapter, OnlinePaymentAuthorized, OnlinePaymentEvent, OnlinePaymentProcessing, OnlineRefundChanged } from "../types";

export const stripeAdapter: OnlinePaymentAdapter = {
  async resumePayment(attempt) {
    const intent = await stripeClient().paymentIntents.retrieve(attempt.providerPaymentId);
    if (intent.id !== attempt.providerPaymentId || intent.metadata.payment_attempt_id !== attempt.id || !intent.client_secret)
      throw new StripeProviderError("creation");
    return { kind: "stripe", clientSecret: intent.client_secret, publishableKey: stripeConfig().publishableKey };
  },
  async readPayment(attempt) {
    const intent = await stripeClient().paymentIntents.retrieve(attempt.providerPaymentId, {}, {
      timeout: 3000, maxNetworkRetries: 0,
    });
    if (intent.id !== attempt.providerPaymentId || intent.metadata.payment_attempt_id !== attempt.id)
      throw new StripeProviderError("cancellation");
    return {
      status: intent.status === "succeeded" ? "succeeded" : intent.status === "canceled" ? "cancelled"
        : intent.status === "requires_capture" ? "authorized"
        : intent.status === "processing" || intent.status === "requires_action" ? "processing" : "pending",
      amountMinor: intent.status === "succeeded" ? intent.amount_received
        : intent.status === "requires_capture" ? intent.amount_capturable : intent.amount,
      currency: intent.currency.toUpperCase(),
      // Each PaymentIntent is captured at most once (in full); the intent is the
      // stable provider identity for its one successful collection.
      providerCaptureId: intent.status === "succeeded" ? intent.id : null,
      live: liveIntent(intent.status),
    };
  },
  async refundPayment(refund) {
    const client = stripeClient();
    let result: Stripe.Refund | undefined;
    let operation: "discover" | "retrieve" | "create" = "discover";
    // Fully paginate the payment's refunds even when a local provider ID exists.
    // Metadata binds evidence to this exact immutable obligation/execution; amount
    // alone is never enough. Multiple matching records are an explicit exception.
    try {
      for await (const existing of client.refunds.list({
        payment_intent: refund.providerPaymentId, limit: 100,
      })) {
        if (existing.metadata?.payment_refund_id === refund.id
          && existing.metadata.refund_execution_id === refund.executionId) {
          if (result) throw new RefundProviderError({ kind: "evidence_mismatch", operation,
            providerRefundId: existing.id });
          result = existing;
        }
      }
    } catch (error) {
      if (error instanceof RefundProviderError) throw error;
      throw new RefundProviderError({ kind: "lookup_failed", operation, providerRefundId: refund.providerRefundId });
    }
    if (refund.providerRefundId) {
      operation = "retrieve";
      if (!result || result.id !== refund.providerRefundId)
        throw new RefundProviderError({ kind: "evidence_mismatch", operation, providerRefundId: refund.providerRefundId });
      try { result = await client.refunds.retrieve(refund.providerRefundId); }
      catch { throw new RefundProviderError({ kind: "lookup_failed", operation, providerRefundId: refund.providerRefundId }); }
    }
    if (!result) {
      // An empty lookup cannot prove that an earlier request was not accepted.
      // Recovery must not rely on indefinite provider idempotency retention;
      // a replay re-sends the identical request under its original key, which
      // Stripe resolves to the first refund if that request had executed.
      if (refund.operation === "recover" || refund.dispatchInitiatedAt !== undefined
        && !(Date.now() - Date.parse(refund.dispatchInitiatedAt) < 23 * 60 * 60 * 1000))
        throw new RefundProviderError({ kind: "not_found", operation: "discover", providerRefundId: null });
      operation = "create";
      try {
        result = await client.refunds.create(
          {
            payment_intent: refund.providerPaymentId,
            amount: refund.amountMinor,
            metadata: { payment_refund_id: refund.id, refund_execution_id: refund.executionId },
          },
          { idempotencyKey: refund.idempotencyKey },
        );
      } catch (error) {
        // Require an actual rejection response, not merely an exception class.
        // Conflict/idempotency errors may concern an already running operation.
        const rejected = error instanceof Stripe.errors.StripeInvalidRequestError
          && [400, 404, 422].includes(error.statusCode ?? 0)
          && error.code !== "idempotency_key_in_use";
        throw new RefundProviderError({ kind: rejected ? "request_rejected" : "uncertain",
          operation, providerRefundId: null,
          ...(rejected ? { retryable: error.code === "balance_insufficient", failureReason: error.code ?? "invalid_request" } : {}) });
      }
    }
    if ((refund.providerRefundId && result.id !== refund.providerRefundId)
      || result.metadata?.payment_refund_id !== refund.id
      || result.metadata.refund_execution_id !== refund.executionId
      || result.amount !== refund.amountMinor
      || result.currency.toUpperCase() !== refund.currency
      || result.payment_intent !== refund.providerPaymentId)
      throw new RefundProviderError({ kind: "evidence_mismatch", operation,
        providerRefundId: refund.providerRefundId ?? result.id });
    return {
      providerRefundId: result.id,
      // Retry only a known transient failure after authoritative terminal failure.
      // Card/bank refusal, disputes and unknown reasons require external resolution.
      retryable: result.status === "failed" && result.failure_reason === "insufficient_funds",
      failureReason: result.failure_reason ?? undefined,
      status: result.status === "succeeded" ? "succeeded"
        : result.status === "failed" || result.status === "canceled" ? "failed" : "pending",
    };
  },
  async cancelPayment(attempt) {
    try {
      const client = stripeClient();
      const intent = await client.paymentIntents.retrieve(
        attempt.providerPaymentId,
      );
      if (intent.status === "canceled") return "cancelled";
      if (intent.status === "succeeded") return "succeeded";
      // Stripe permits cancellation in some processing states. Attempt it;
      // retrieve again on failure rather than assuming the request succeeded.
      try {
        const cancelled = await client.paymentIntents.cancel(
          attempt.providerPaymentId,
          { cancellation_reason: "abandoned" },
          { idempotencyKey: `court-payment-abandon-${attempt.id}` },
        );
        if (cancelled.status === "canceled") return "cancelled";
      } catch {
        // A webhook, another cancellation, or payment completion may win the race.
        const latest = await client.paymentIntents.retrieve(
          attempt.providerPaymentId,
        );
        if (latest.status === "canceled") return "cancelled";
        if (latest.status === "succeeded") return "succeeded";
        if (latest.status === "processing") return "processing";
      }
      throw new StripeProviderError("cancellation");
    } catch {
      throw new StripeProviderError("cancellation");
    }
  },
  async capturePayment(attempt) {
    const client = stripeClient();
    const evidence = (intent: Stripe.PaymentIntent) => {
      if (intent.id !== attempt.providerPaymentId || intent.metadata.payment_attempt_id !== attempt.id)
        throw new StripeProviderError("capture");
      if (intent.status === "succeeded") return { status: "succeeded" as const, amountMinor: intent.amount_received,
        currency: intent.currency.toUpperCase(), providerCaptureId: intent.id };
      if (intent.status === "canceled") return { status: "cancelled" as const, amountMinor: intent.amount,
        currency: intent.currency.toUpperCase(), providerCaptureId: null };
      throw new StripeProviderError("capture");
    };
    try {
      // SDK transport/reconnect retries belong to this accepted operation and may
      // finish after operational grace. Every dispatch uses the same stable key.
      return evidence(await client.paymentIntents.capture(attempt.providerPaymentId, {},
        { idempotencyKey: `court-capture-${attempt.id}` }));
    } catch (error) {
      if (error instanceof StripeProviderError) throw error;
      // The capture may have run (lost response) or the authorization may have
      // ended; only a re-read decides. Anything else stays unknown.
      return evidence(await client.paymentIntents.retrieve(attempt.providerPaymentId));
    }
  },
  async dismissPayment(attempt) {
    const client = stripeClient();
    const read = async () => {
      const intent = await client.paymentIntents.retrieve(attempt.providerPaymentId);
      if (intent.id !== attempt.providerPaymentId || intent.metadata.payment_attempt_id !== attempt.id)
        throw new StripeProviderError("cancellation");
      return intent.status;
    };
    const settled = (status: Stripe.PaymentIntent.Status) => status === "canceled" ? "cancelled" as const
      : status === "succeeded" ? "succeeded" as const : liveIntent(status) ? "live" as const : null;
    const current = settled(await read());
    if (current) return current;
    try {
      const cancelled = await client.paymentIntents.cancel(attempt.providerPaymentId,
        { cancellation_reason: "abandoned" }, { idempotencyKey: `court-payment-abandon-${attempt.id}` });
      if (cancelled.status === "canceled") return "cancelled";
    } catch { /* The intent may have moved to processing or succeeded; re-read it. */ }
    const latest = settled(await read());
    if (latest) return latest;
    throw new StripeProviderError("cancellation");
  },
  async createPayment(attempt) {
    try {
      const intent = await stripeClient().paymentIntents.create(
        {
          amount: attempt.amountMinor,
          currency: attempt.currency.toLowerCase(),
          allowed_payment_method_types: ["card"],
          // Booking and surcharge checkouts authorize only; the server captures inside the deadline.
          capture_method: "manual",
          metadata: { payment_attempt_id: attempt.id },
        },
        { idempotencyKey: `court-payment-${attempt.id}` },
      );
      if (!intent.client_secret) throw new StripeProviderError("creation");
      return {
        providerPaymentId: intent.id,
        presentation: {
          kind: "stripe",
          clientSecret: intent.client_secret,
          publishableKey: stripeConfig().publishableKey,
        },
      };
    } catch {
      throw new StripeProviderError("creation");
    }
  },
};

// Submitted and still able to succeed without the customer or the server.
// A manual-capture authorization (requires_capture) waits for the server instead.
function liveIntent(status: Stripe.PaymentIntent.Status) {
  return status === "processing";
}

export function verifyStripeEvent(
  body: string,
  signature: string,
): OnlinePaymentEvent | OnlinePaymentProcessing | OnlinePaymentAuthorized | OnlineRefundChanged | null {
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      body,
      signature,
      stripeConfig().webhookSecret,
    );
  } catch {
    throw new StripeProviderError("signature");
  }
  if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed") {
    // Only refunds this application created carry its obligation identity.
    const refundId = z.uuid().safeParse(event.data.object.metadata?.payment_refund_id);
    return refundId.success ? { provider: "stripe", refundId: refundId.data, outcome: "refund_changed" } : null;
  }
  if (event.type === "payment_intent.processing" || event.type === "payment_intent.amount_capturable_updated") {
    const attemptId = z.uuid().safeParse(event.data.object.metadata.payment_attempt_id);
    return attemptId.success ? { provider: "stripe", attemptId: attemptId.data, providerPaymentId: event.data.object.id,
      outcome: event.type === "payment_intent.processing" ? "processing" : "authorized" } : null;
  }
  if (
    event.type !== "payment_intent.succeeded" &&
    event.type !== "payment_intent.payment_failed" &&
    event.type !== "payment_intent.canceled"
  )
    return null;
  const intent = event.data.object;
  const attemptId = z.uuid().safeParse(intent.metadata.payment_attempt_id);
  // Other integrations on the same Stripe account are outside this workflow.
  if (!attemptId.success) return null;
  return {
    provider: "stripe",
    eventId: event.id,
    attemptId: attemptId.data,
    providerPaymentId: intent.id,
    providerCaptureId: event.type === "payment_intent.succeeded" ? intent.id : undefined,
    outcome:
      event.type === "payment_intent.succeeded"
        ? "succeeded"
        : event.type === "payment_intent.canceled" ||
            intent.status === "canceled"
          ? "cancelled"
          : "retryable_failed",
    amountMinor:
      event.type === "payment_intent.succeeded"
        ? intent.amount_received
        : intent.amount,
    currency: intent.currency.toUpperCase(),
  };
}
