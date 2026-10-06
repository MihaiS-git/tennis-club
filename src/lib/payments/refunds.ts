import "server-only";

import { z } from "zod";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { logger } from "@/lib/logger";
import { RefundProviderError } from "./providers/types";
import { onlinePaymentAdapter } from "./providers";
import { commandFence, readBookingContext } from "@/lib/bookings/persistence";
import { resolvableRefundEvents } from "./providers/stripe/refund-policy";

export type RefundStatus = "pending" | "pending_retry" | "succeeded" | "failed";
export type BookingCancellationResult = { ok: true; refundStatus?: RefundStatus }
  | { ok: false; message: string };
const refundSchema = z.object({ id: z.uuid(), provider: z.literal("stripe"),
  provider_payment_id: z.string().min(1), provider_refund_id: z.string().nullable(),
  amount_minor: z.number().int().positive(), currency: z.string().length(3),
  status: z.enum(["pending", "pending_retry", "succeeded", "failed"]) });

// Called only with a refund ID returned by an authorized cancellation transaction.
// Replays/reconciliation reuse this same server-only operation and original attempt.
export async function processBookingRefund(id: string,
  writer?: ReturnType<typeof createBookingWriter>,
  adminClaim?: { token: string; actorId: string; bookingId: string }): Promise<RefundStatus> {
  let providerRefundId: string | null = null;
  let status: RefundStatus = "pending_retry";
  let lastError: string | null = null;
  try {
    writer ??= createBookingWriter();
    const read = await writer.from("payment_refunds").select("*").eq("id", id).single();
    if (read.error) throw new Error("Refund read failed");
    const refund = refundSchema.parse(read.data);
    if (!adminClaim && (refund.status === "succeeded" || refund.status === "failed")) return refund.status;
    providerRefundId = refund.provider_refund_id;
    if (refund.status === "succeeded") status = "succeeded";
    else {
      const result = await (await onlinePaymentAdapter(refund.provider)).refundPayment({
        id: refund.id, providerPaymentId: refund.provider_payment_id, providerRefundId,
        amountMinor: refund.amount_minor, currency: refund.currency,
      });
      providerRefundId = result.providerRefundId;
      status = result.status;
      if (status === "failed") lastError = "provider_refund_failed";
    }
  } catch (error) {
    if (adminClaim && error instanceof RefundProviderError && !error.retryable) status = "failed";
    // Ambiguous transport failures remain retryable; never reverse cancellation.
    lastError = status === "failed" ? "provider_refund_failed" : "provider_request_incomplete";
    logger.error({ event: "payments.refund_retry_required", refundId: id }, "Full refund requires retry");
  }
  try {
    if (!writer) return status;
    if (adminClaim) {
      for (let retry = 0; retry < 4; retry++) {
        const context = await readBookingContext(adminClaim.bookingId, writer);
        if (!context?.refund || context.refund.id !== id) throw new Error("Refund context missing");
        if (context.refund.status === "succeeded") {
          status = "succeeded";
          providerRefundId = context.refund.provider_refund_id;
          lastError = null;
        }
        const finished = await writer.rpc("commit_refund_result", {
          p_refund_id: id, p_token: adminClaim.token, p_actor_id: adminClaim.actorId,
          p_status: status, p_provider_refund_id: providerRefundId, p_error: lastError,
          p_events: status === "succeeded" ? resolvableRefundEvents(context, context.refund.payment_attempt_id) : [],
          ...commandFence(context),
        });
        if (finished.error?.code === "40001") continue;
        if (finished.error || !["pending", "pending_retry", "succeeded", "failed"].includes(finished.data))
          throw new Error("Refund result write failed");
        return z.enum(["pending", "pending_retry", "succeeded", "failed"]).parse(finished.data);
      }
      throw new Error("Refund changed concurrently");
    }
    const update = await writer.from("payment_refunds").update({ status,
      ...(providerRefundId ? { provider_refund_id: providerRefundId } : {}), last_error: lastError })
      .eq("id", id).in("status", ["pending", "pending_retry"]).select("status");
    if (update.error) throw new Error("Refund result write failed");
    // Concurrent requests must not downgrade a successful/terminal result.
    if (!update.data?.length) {
      const latest = await writer.from("payment_refunds").select("*").eq("id", id).single();
      if (latest.error) throw new Error("Refund result read failed");
      return refundSchema.parse(latest.data).status;
    }
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund result needs reconciliation");
    return "pending_retry";
  }
  logger.info({ event: "payments.refund_result", refundId: id, status }, "Full refund result persisted");
  return status;
}

export async function finishBookingCancellation(data: unknown, unavailableMessage = "This booking is no longer available for cancellation."): Promise<BookingCancellationResult> {
  const result = z.object({ outcome: z.string(), refund_id: z.uuid().nullable() }).safeParse(data);
  if (!result.success) return { ok: false, message: "Unable to cancel this booking. Try again." };
  if (result.data.outcome !== "cancelled") {
    const messages: Record<string, string> = {
      started: "This booking has started and can no longer be cancelled here.",
      notice_required: "The cancellation notice period for this booking has expired.",
      refund_choice_required: "Choose whether to refund the full payment.",
    };
    return { ok: false, message: messages[result.data.outcome] ?? unavailableMessage };
  }
  return result.data.refund_id ? { ok: true, refundStatus: await processBookingRefund(result.data.refund_id) } : { ok: true };
}
