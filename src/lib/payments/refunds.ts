import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";
import { RefundProviderError } from "./providers/types";
import { onlinePaymentAdapter } from "./providers";
import { prepareAutomaticRefund, commitAutomaticRefund, commitAdminRefund, type AdminRefundClaim } from "./refund-commands";

export type RefundStatus = "pending" | "pending_retry" | "succeeded" | "failed";
export type BookingCancellationResult = { ok: true; refundStatus?: RefundStatus }
  | { ok: false; message: string };

// Automatic processing intentionally has no lease.
export async function processBookingRefund(id: string,
  adminClaim?: AdminRefundClaim): Promise<RefundStatus> {
  let refund;
  try {
    refund = adminClaim?.refund ?? await prepareAutomaticRefund(id);
    if (!refund || refund.id !== id) throw new Error("Refund read failed");
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund preparation failed");
    return "pending_retry";
  }
  if (!adminClaim && (refund.status === "succeeded" || refund.status === "failed")) return refund.status;
  let providerRefundId = refund.provider_refund_id;
  let status: RefundStatus = "pending_retry";
  let lastError: string | null = null;
  try {
    const result = await (await onlinePaymentAdapter(refund.provider)).refundPayment({
      id: refund.id, providerPaymentId: refund.provider_payment_id, providerRefundId,
      amountMinor: refund.amount_minor, currency: refund.currency,
    });
    providerRefundId = result.providerRefundId;
    status = result.status;
    if (status === "failed") lastError = "provider_refund_failed";
  } catch (error) {
    if (adminClaim && error instanceof RefundProviderError && !error.retryable) status = "failed";
    lastError = status === "failed" ? "provider_refund_failed" : "provider_request_incomplete";
    logger.error({ event: "payments.refund_retry_required", refundId: id }, "Full refund requires retry");
  }
  try {
    const result = { status, providerRefundId, lastError };
    const persisted = adminClaim ? await commitAdminRefund(adminClaim, result) : await commitAutomaticRefund(id, result, refund);
    logger.info({ event: "payments.refund_result", refundId: id, status: persisted }, "Full refund result persisted");
    return persisted;
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund result needs reconciliation");
    return "pending_retry";
  }
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
