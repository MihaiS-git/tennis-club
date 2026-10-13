import "server-only";
import { z } from "zod";
import Stripe from "stripe";
import { RefundProviderError } from "../types";
import { stripeClient, StripeProviderError } from "./client";
import { stripeConfig } from "./config";
import type { OnlinePaymentAdapter, OnlinePaymentEvent } from "../types";

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
        : intent.status === "processing" || intent.status === "requires_capture" || intent.status === "requires_action" ? "processing" : "pending",
      amountMinor: intent.status === "succeeded" ? intent.amount_received : intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  },
  async refundPayment(refund) {
    try {
      const client = stripeClient();
      let result;
      if (refund.providerRefundId)
        result = await client.refunds.retrieve(refund.providerRefundId);
      else {
        // Recover an accepted response even after Stripe's idempotency retention expires.
        for await (const existing of client.refunds.list({
          payment_intent: refund.providerPaymentId,
          limit: 100,
        })) {
          if (existing.metadata?.payment_refund_id === refund.id && Number(existing.metadata.refund_generation ?? 0) === (refund.generation ?? 0)) {
            result = existing;
            break;
          }
        }
        result ??= await client.refunds.create(
          {
            payment_intent: refund.providerPaymentId,
            amount: refund.amountMinor,
            metadata: { payment_refund_id: refund.id, ...(refund.generation ? { refund_generation: String(refund.generation) } : {}) },
          },
          { idempotencyKey: `court-payment-refund-${refund.id}${refund.generation ? `-retry-${refund.generation}` : ""}` },
        );
      }
      if (
        result.amount !== refund.amountMinor ||
        result.currency.toUpperCase() !== refund.currency ||
        result.payment_intent !== refund.providerPaymentId
      )
        throw new StripeProviderError("refund");
      return {
        providerRefundId: result.id,
        status:
          result.status === "succeeded"
            ? "succeeded"
            : result.status === "failed" || result.status === "canceled"
              ? "failed"
              : "pending",
      };
    } catch (error) {
      throw new RefundProviderError(!(error instanceof Stripe.errors.StripeInvalidRequestError));
    }
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
  async createPayment(attempt) {
    try {
      const intent = await stripeClient().paymentIntents.create(
        {
          amount: attempt.amountMinor,
          currency: attempt.currency.toLowerCase(),
          allowed_payment_method_types: ["card"],
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

export function verifyStripeEvent(
  body: string,
  signature: string,
): OnlinePaymentEvent | null {
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
