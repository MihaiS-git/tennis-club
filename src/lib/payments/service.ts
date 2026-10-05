import "server-only";

import { z } from "zod";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { logger } from "@/lib/logger";
import { paymentProviderSchema } from "./domain";

// Trusted provider adapters may call this after verifying provider evidence.
// It is deliberately not exposed as a Server Action or HTTP endpoint.
export async function settleOnlinePayment(input: unknown, writer = createBookingWriter()) {
  const value = z.strictObject({ attemptId: z.uuid(), provider: paymentProviderSchema,
    providerPaymentId: z.string().trim().min(1).max(255),
    outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]) }).parse(input);
  const result = await writer.rpc("settle_online_payment", {
    p_attempt_id: value.attemptId, p_provider: value.provider,
    p_provider_payment_id: value.providerPaymentId, p_outcome: value.outcome,
  });
  if (result.error) {
    logger.error({ event: "payments.settlement_failed", attemptId: value.attemptId, code: result.error.code }, "Payment settlement failed");
    throw new Error("Unable to update payment lifecycle.");
  }
  return z.enum(["succeeded", "failed", "cancelled", "pending", "expired", "unavailable"]).parse(result.data);
}

export async function processOnlinePaymentEvent(input: import("./providers/types").OnlinePaymentEvent,
  writer = createBookingWriter()) {
  const value = z.strictObject({ provider: paymentProviderSchema, eventId: z.string().min(1).max(255),
    attemptId: z.uuid(), providerPaymentId: z.string().min(1).max(255), outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]),
    amountMinor: z.number().int().nonnegative(), currency: z.string().length(3) }).parse(input);
  const result = await writer.rpc("process_online_payment_event", {
    p_provider: value.provider, p_event_id: value.eventId, p_attempt_id: value.attemptId,
    p_provider_payment_id: value.providerPaymentId, p_outcome: value.outcome,
    p_amount_minor: value.amountMinor, p_currency: value.currency,
  });
  if (result.error) {
    logger.error({ event: "payments.event_failed", eventId: value.eventId, code: result.error.code }, "Payment event failed");
    throw new Error("Unable to process payment event.");
  }
  if (value.outcome === "succeeded" && result.data !== "succeeded" && result.data !== "unavailable")
    logger.error({ event: "payments.reconciliation_required", attemptId: value.attemptId, eventId: value.eventId,
      result: result.data }, "Successful payment requires reconciliation");
  return result.data;
}
