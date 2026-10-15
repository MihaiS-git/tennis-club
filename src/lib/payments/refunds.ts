import "server-only";

import type { BookingCancellationCommandResult } from "@/lib/bookings/domain";
import { summarizeRefunds } from "./domain";
import { logger } from "@/lib/logger";
import { RefundProviderError } from "./providers/types";
import { onlinePaymentAdapter } from "./providers";
import { prepareAutomaticRefund, initiateRefundExecution, commitRefundExecution, type RefundExecutionClaim, type RefundObservation } from "./refund-commands";

export type RefundStatus = "pending" | "pending_retry" | "succeeded" | "failed";
export type BookingCancellationResult = { ok: true; refundStatus?: RefundStatus }
  | { ok: false; message: string };

export async function processBookingRefund(id: string,
  preparedClaim?: RefundExecutionClaim): Promise<RefundStatus> {
  let claim: RefundExecutionClaim;
  let dispatch: Awaited<ReturnType<typeof initiateRefundExecution>>;
  try {
    const prepared = preparedClaim ? { outcome: "ready" as const, claim: preparedClaim } : await prepareAutomaticRefund(id);
    if (prepared.outcome !== "ready") return prepared.status;
    claim = prepared.claim;
    if (claim.refund.id !== id) throw new Error("Refund read failed");
    // This transaction commits dispatch evidence before any provider request.
    dispatch = await initiateRefundExecution(claim);
    if (dispatch.outcome === "terminal") return dispatch.status;
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund preparation failed");
    return "pending_retry";
  }
  const execution = dispatch.execution;
  let observation: RefundObservation;
  try {
    const result = await (await onlinePaymentAdapter(execution.provider)).refundPayment({
      id, executionId: execution.id, idempotencyKey: execution.idempotencyKey, operation: dispatch.operation,
      providerPaymentId: execution.providerPaymentId, providerRefundId: execution.providerRefundId,
      amountMinor: execution.amountMinor, currency: execution.currency,
    });
    observation = { kind: "verified", ...result };
  } catch (error) {
    observation = { kind: "error", evidence: error instanceof RefundProviderError ? error.evidence
      : dispatch.operation === "create" ? { kind: "uncertain", operation: "create", providerRefundId: null }
        : { kind: "lookup_failed", operation: execution.providerRefundId ? "retrieve" : "discover",
          providerRefundId: execution.providerRefundId } };
    logger.error({ event: "payments.refund_retry_required", refundId: id }, "Refund requires recovery");
  }
  try {
    const status = await commitRefundExecution(claim, observation);
    logger.info({ event: "payments.refund_result", refundId: id, status }, "Refund result persisted");
    return status;
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund result needs reconciliation");
    return "pending_retry";
  }
}

export async function finishBookingCancellation(result: BookingCancellationCommandResult,
  unavailableMessage = "This booking is no longer available for cancellation."): Promise<BookingCancellationResult> {
  switch (result.outcome) {
    case "started":
      return { ok: false, message: "This booking has started and can no longer be cancelled here." };
    case "notice_required":
      return { ok: false, message: "The cancellation notice period for this booking has expired." };
    case "inactive":
    case "unavailable":
      return { ok: false, message: unavailableMessage };
    case "cancelled": {
      const statuses = await Promise.all(result.refundIds.map(id => processBookingRefund(id)));
      const refundStatus = summarizeRefunds(statuses);
      return refundStatus ? { ok: true, refundStatus } : { ok: true };
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
