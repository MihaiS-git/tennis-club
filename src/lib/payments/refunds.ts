import "server-only";

import type { BookingCancellationCommandResult } from "@/lib/bookings/domain";
import { resolveRefundBackedAdjustment } from "@/lib/bookings/commands";
import { getDataSource } from "@/lib/db/data-source";
import { findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import { findRefundOperation } from "@/lib/db/repositories/payments.repository";
import { summarizeRefunds } from "./domain";
import { logger } from "@/lib/logger";
import { RefundProviderError } from "./providers/types";
import { onlinePaymentAdapter } from "./providers";
import { completedRefundExecution, prepareRefund, initiateRefundExecution, commitRefundExecution, recordProviderRefundReversal,
  type RefundExecutionClaim, type RefundObservation } from "./refund-commands";

// voided: the obligation of an abandoned booking change after verified failure.
export type RefundStatus = "pending" | "pending_retry" | "succeeded" | "failed" | "voided";
export type BookingCancellationResult =
  | { ok: true; outcome: "cancelled"; refundStatus?: RefundStatus }
  // Requested: the booking stays confirmed until the refund is verified.
  | { ok: true; outcome: "cancellation_pending" }
  | { ok: false; message: string };

// Shared refund processing for request threads, signed Stripe refund webhooks
// and the Admin "Check with Stripe" action. An unconfirmed execution is only
// looked up (or replayed with its exact idempotency key). A replacement execution
// follows affirmative retryable provider rejection only when an Admin asks.
type RefundProcessingOptions = {
  actorId?: string; retryRejected?: boolean;
  // Webhook and Admin callers: an internal failure, a busy execution or a
  // transient provider failure throws instead of returning a status, so Stripe
  // redelivers the event (or the Admin is told) rather than it being acknowledged.
  strict?: boolean;
  // A signed refund webhook: a refund already recorded as succeeded is re-read at
  // Stripe, because Stripe can later fail a succeeded refund.
  providerChanged?: boolean;
};
export class RefundProcessingError extends Error {
  constructor(message = "Refund processing did not complete.") { super(message); }
}
export class RefundInProgressError extends RefundProcessingError {
  constructor() { super("Refund is already being processed."); }
}

function deferred(options: RefundProcessingOptions, id: string, message: string): RefundStatus {
  logger.error({ event: "payments.refund_persistence_failed", refundId: id }, message);
  if (options.strict) throw new RefundProcessingError();
  return "pending_retry";
}

export async function processBookingRefund(id: string, options: RefundProcessingOptions = {}): Promise<RefundStatus> {
  let prepared: Awaited<ReturnType<typeof prepareRefund>>;
  try { prepared = await prepareRefund(id, options); }
  catch { return deferred(options, id, "Refund preparation failed"); }
  if (prepared.outcome === "busy") {
    if (options.strict) throw new RefundInProgressError();
    return prepared.status;
  }
  if (prepared.outcome === "terminal") {
    const status = prepared.status === "succeeded" && options.providerChanged ? await reverifyCompletedRefund(id, options) : prepared.status;
    return afterRefundOutcome(id, status, prepared.requiresResolution, options);
  }
  const claim: RefundExecutionClaim = prepared.claim;
  let dispatch: Awaited<ReturnType<typeof initiateRefundExecution>>;
  try {
    if (claim.refund.id !== id) throw new Error("Refund read failed");
    // This transaction commits dispatch evidence before any provider request.
    dispatch = await initiateRefundExecution(claim);
  } catch { return deferred(options, id, "Refund preparation failed"); }
  if (dispatch.outcome === "terminal") return dispatch.status;
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
    logger.warn({ event: "payments.refund_unconfirmed", refundId: id }, "Refund outcome unconfirmed; awaiting Stripe webhook or Admin check");
  }
  let committed: Awaited<ReturnType<typeof commitRefundExecution>>;
  try {
    committed = await commitRefundExecution(claim, observation);
    logger.info({ event: "payments.refund_result", refundId: id, status: committed.status }, "Refund result persisted");
  } catch { return deferred(options, id, "Refund result needs reconciliation"); }
  const status = await afterRefundOutcome(id, committed.status, committed.requiresResolution, options);
  // The uncertainty is committed; Stripe was unreachable, so the event is not processed.
  if (options.strict && observation.kind === "error" && ["uncertain", "lookup_failed"].includes(observation.evidence.kind))
    throw new RefundProcessingError("Stripe did not confirm the refund.");
  return status;
}

// Retrieves and verifies the exact Stripe refund (metadata, payment, amount and
// currency). A provider failure after success is recorded as the current
// exception; nothing is refunded again.
async function reverifyCompletedRefund(id: string, options: RefundProcessingOptions): Promise<RefundStatus> {
  const execution = await completedRefundExecution(id);
  if (!execution?.providerRefundId) return "succeeded";
  let result;
  try {
    result = await (await onlinePaymentAdapter(execution.provider)).refundPayment({
      id, executionId: execution.id, idempotencyKey: execution.idempotencyKey, operation: "recover",
      providerPaymentId: execution.providerPaymentId, providerRefundId: execution.providerRefundId,
      amountMinor: execution.amountMinor, currency: execution.currency,
      dispatchInitiatedAt: execution.dispatchInitiatedAt?.toISOString(),
    });
  } catch {
    logger.warn({ event: "payments.refund_recheck_failed", refundId: id }, "Unable to re-read a completed refund");
    if (options.strict) throw new RefundProcessingError("Stripe did not confirm the refund.");
    return "succeeded";
  }
  if (result.status !== "failed") return "succeeded";
  try {
    const reversed = await recordProviderRefundReversal(id, result.providerRefundId);
    logger.error({ event: "payments.refund_reversed", refundId: id, failureReason: result.failureReason },
      "Stripe failed a refund after reporting it succeeded");
    if (reversed.requiresResolution) logger.error({ event: "payments.refund_requires_resolution", refundId: id }, "Outstanding refund requires external resolution");
    return reversed.status;
  } catch { return deferred(options, id, "Refund reversal needs reconciliation"); }
}

// Post-commit only. A terminal obligation can decide the booking change waiting
// on it; the change command is transition-guarded, so replays are harmless.
async function afterRefundOutcome(id: string, status: RefundStatus, requiresResolution: boolean,
  options: RefundProcessingOptions): Promise<RefundStatus> {
  if (requiresResolution) {
    logger.error({ event: "payments.refund_requires_resolution", refundId: id }, "Outstanding refund requires external resolution");
  }
  if (status !== "succeeded" && status !== "failed") return status;
  try {
    const operation = await findRefundOperation((await getDataSource()).manager, id);
    if (operation?.adjustmentId && (operation.reason === "booking_cancellation" || operation.reason === "booking_price_reduction"))
      await resolveRefundBackedAdjustment(operation.adjustmentId);
  } catch {
    // The obligation outcome is committed; any later check of this refund
    // (Stripe webhook redelivery or Admin) re-runs this transition-guarded decision.
    logger.error({ event: "bookings.refund_change_resolution_deferred", refundId: id }, "Booking change resolution deferred");
    if (options.strict) throw new RefundProcessingError("The booking change waiting on this refund was not applied.");
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
      // Usually Stripe confirms immediately; otherwise the Stripe refund webhook
      // (or an Admin check) finishes the request.
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
