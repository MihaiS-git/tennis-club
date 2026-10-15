import "server-only";

import type { BookingCancellationCommandResult } from "@/lib/bookings/domain";
import { resolveRefundBackedAdjustment } from "@/lib/bookings/commands";
import { getDataSource } from "@/lib/db/data-source";
import { findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import { findRefundOperation } from "@/lib/db/repositories/payments.repository";
import { type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { summarizeRefunds } from "./domain";
import { logger } from "@/lib/logger";
import { RefundProviderError } from "./providers/types";
import { onlinePaymentAdapter } from "./providers";
import { prepareAutomaticRefund, initiateRefundExecution, commitRefundExecution, type RefundExecutionClaim, type RefundObservation } from "./refund-commands";

// voided: the obligation of an abandoned booking change after verified failure.
export type RefundStatus = "pending" | "pending_retry" | "succeeded" | "failed" | "voided";
export type BookingCancellationResult =
  | { ok: true; outcome: "cancelled"; refundStatus?: RefundStatus }
  // Requested: the booking stays confirmed until the refund is verified.
  | { ok: true; outcome: "cancellation_pending" }
  | { ok: false; message: string };

// Shared automatic processing for request threads and the recovery worker. It
// replaces a failed execution only with affirmative retryable provider evidence.
export async function processBookingRefund(id: string,
  preparedClaim?: RefundExecutionClaim): Promise<RefundStatus> {
  let claim: RefundExecutionClaim;
  let dispatch: Awaited<ReturnType<typeof initiateRefundExecution>>;
  try {
    const prepared = preparedClaim ? { outcome: "ready" as const, claim: preparedClaim } : await prepareAutomaticRefund(id);
    if (prepared.outcome === "busy") return prepared.status;
    if (prepared.outcome === "terminal") return await afterRefundOutcome(id, prepared.status, prepared.notice);
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
      dispatchInitiatedAt: execution.dispatchInitiatedAt?.toISOString(),
    });
    observation = { kind: "verified", ...result };
  } catch (error) {
    observation = { kind: "error", evidence: error instanceof RefundProviderError ? error.evidence
      : dispatch.operation !== "recover" ? { kind: "uncertain", operation: "create", providerRefundId: null }
        : { kind: "lookup_failed", operation: execution.providerRefundId ? "retrieve" : "discover",
          providerRefundId: execution.providerRefundId } };
    logger.warn({ event: "payments.refund_retry_scheduled", refundId: id }, "Refund outcome unconfirmed; automatic recovery will retry");
  }
  let committed: Awaited<ReturnType<typeof commitRefundExecution>>;
  try {
    committed = await commitRefundExecution(claim, observation);
    logger.info({ event: "payments.refund_result", refundId: id, status: committed.status }, "Refund result persisted");
  } catch {
    logger.error({ event: "payments.refund_persistence_failed", refundId: id }, "Refund result needs reconciliation");
    return "pending_retry";
  }
  return afterRefundOutcome(id, committed.status, committed.notice);
}

// Post-commit only. A terminal obligation can decide the booking change waiting
// on it; the change command is transition-guarded, so replays are harmless.
async function afterRefundOutcome(id: string, status: RefundStatus, notice: BookingEmailEvent | null): Promise<RefundStatus> {
  if (notice) {
    logger.error({ event: "payments.refund_requires_resolution", refundId: id }, "Outstanding refund requires external resolution");
  }
  if (status !== "succeeded" && status !== "failed") return status;
  try {
    const operation = await findRefundOperation((await getDataSource()).manager, id);
    if (operation?.adjustmentId && (operation.reason === "booking_cancellation" || operation.reason === "booking_price_reduction"))
      await resolveRefundBackedAdjustment(operation.adjustmentId);
  } catch {
    // The obligation outcome is committed; the recovery worker decides the change.
    logger.error({ event: "bookings.refund_change_resolution_deferred", refundId: id }, "Booking change resolution deferred to recovery");
  }
  return status;
}

export async function finishBookingCancellation(result: BookingCancellationCommandResult,
  unavailableMessage = "This booking is no longer available for cancellation."): Promise<BookingCancellationResult> {
  switch (result.outcome) {
    case "started":
      return { ok: false, message: "This booking has started and can no longer be cancelled here." };
    case "notice_required":
      return { ok: false, message: "The cancellation notice period for this booking has expired." };
    case "change_pending":
      return { ok: false, message: "A change to this booking is still being processed. Try again shortly." };
    case "inactive":
    case "unavailable":
      return { ok: false, message: unavailableMessage };
    case "cancelled": {
      const statuses = await Promise.all(result.refundIds.map(id => processBookingRefund(id)));
      const refundStatus = summarizeRefunds(statuses);
      return refundStatus ? { ok: true, outcome: "cancelled", refundStatus } : { ok: true, outcome: "cancelled" };
    }
    case "cancellation_pending": {
      // Usually Stripe confirms immediately; otherwise recovery finishes the request.
      const statuses = await Promise.all(result.refundIds.map(id => processBookingRefund(id)));
      const request = await findAdjustment((await getDataSource()).manager, result.adjustmentId);
      if (request?.status === "applied") return { ok: true, outcome: "cancelled", refundStatus: summarizeRefunds(statuses) };
      if (request?.status === "unsuccessful") return { ok: false,
        message: "The refund could not be processed, so your booking was not cancelled. It remains confirmed." };
      return { ok: true, outcome: "cancellation_pending" };
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
