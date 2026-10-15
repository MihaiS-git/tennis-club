import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { inTransaction } from "@/lib/db/transaction";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as executions from "@/lib/db/repositories/refund-executions.repository";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import type { RefundExecutionEntity } from "@/lib/db/entities/refund-execution.entity";
import { findBookingCancellationNotice, findBookingForUpdate } from "@/lib/db/repositories/bookings.repository";
import { findInitialRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import { findReservationForUpdate } from "@/lib/db/repositories/reservations.repository";
import { enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import { bookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { refundObligationTotal, reservingObligations } from "./refund-allocation";
import { allocateBookingRefund } from "./financials";
import { refundFinancialSnapshotMatches, paymentHasCapturedEvidence, sameRefundSnapshot } from "./refund-integrity";
import { refundableLateCapture, resolvableRefundEvents } from "./providers/stripe/refund-policy";
import type { RefundProviderFailure } from "./providers/types";
import type { RefundStatus } from "./refunds";

export type RefundExecutionClaim = {
  token: string; actorId: string | null; bookingId: string; refund: payments.ProcessingRefund; execution: RefundExecutionEntity;
};
type ClaimResult = { outcome: "ready"; claim: RefundExecutionClaim }
  | { outcome: "busy"; status: RefundStatus } | { outcome: "terminal"; status: RefundStatus; notice: BookingEmailEvent | null };
export type RefundObservation = { kind: "verified"; status: "pending" | "succeeded" | "failed"; providerRefundId: string; retryable?: boolean; failureReason?: string }
  | { kind: "error"; evidence: RefundProviderFailure };
type RefundDispatchOperation = "create" | "recover" | "replay";
const refundExecutionLeaseMilliseconds = 5 * 60 * 1000;
// Stripe retains idempotency keys for at least 24 hours. Within this margin an
// unconfirmed dispatched request may be re-sent with its exact stored key: Stripe
// returns the original refund if the first request executed, so no duplicate.
const refundReplayWindowMilliseconds = 23 * 60 * 60 * 1000;

// Exceptional obligations notify once through the same durable financial transaction.
async function refundFailureNotice(manager: EntityManager, refund: payments.ProcessingRefund,
  _previous: RefundStatus, status: RefundStatus): Promise<BookingEmailEvent | null> {
  if (status !== "failed") return null;
  // A pending refund-backed change notifies when it is decided (abandoned or exception).
  if (refund.adjustment_id && (refund.reason === "booking_cancellation" || refund.reason === "booking_price_reduction")) return null;
  const revision = await findBookingCancellationNotice(manager, refund.booking_id);
  const notice = revision ? bookingNotification("refund_incomplete", revision,
    { refund: { amountMinor: refund.amount_minor, currency: refund.currency } }) : null;
  if (notice) await enqueueBookingNotification(manager, `refund:${refund.id}:exception`, notice);
  return notice;
}

// Refund-only commands do not change occupancy. All paths use the same order:
// booking -> reservation -> selected attempt -> ordered receipts -> obligation -> execution.
async function lockAggregate(manager: EntityManager, bookingId: string, attemptId: string, refundId?: string) {
  const booking = await findBookingForUpdate(manager, bookingId);
  if (!booking) return null;
  const reservation = await findReservationForUpdate(manager, booking.reservation_id);
  const payment = await payments.lockSettlementAttempt(manager, attemptId);
  if (!reservation || !payment || payment.booking_id !== booking.id) return null;
  await captures.lockCaptureReceiptsForAttempt(manager, payment.id);
  const events = await payments.lockRefundEventsForAttempt(manager, payment.id);
  const selectedRefundId = refundId ?? await payments.refundForAttempt(manager, attemptId, payment.adjustment_id ?? "cancellation");
  const refund = selectedRefundId ? await payments.lockRefundForProcessing(manager, { id: selectedRefundId }) : null;
  return { booking, reservation, payments: [payment], payment, events, refund };
}

async function verifyRefund(manager: EntityManager, refund: payments.ProcessingRefund) {
  const { payment, captures } = await payments.findRefundCaptureEvidence(manager, refund.payment_attempt_id);
  const obligations = await payments.listRefundObligationsForAttempt(manager, refund.payment_attempt_id);
  if (!payment || refundObligationTotal(reservingObligations(obligations)) > payment.amount_minor || !refundFinancialSnapshotMatches(refund, payment)
    || !paymentHasCapturedEvidence(payment, captures)) throw new Error("Refund financial evidence changed");
}
function verifyExecution(refund: payments.ProcessingRefund, execution: RefundExecutionEntity, expected?: RefundExecutionEntity) {
  if (execution.refundId !== refund.id || execution.provider !== refund.provider || execution.providerPaymentId !== refund.provider_payment_id
    || execution.amountMinor !== refund.amount_minor || execution.currency !== refund.currency
    || (expected && (execution.id !== expected.id || execution.executionNumber !== expected.executionNumber
      || execution.idempotencyKey !== expected.idempotencyKey || execution.refundId !== expected.refundId
      || execution.provider !== expected.provider || execution.providerPaymentId !== expected.providerPaymentId
      || execution.amountMinor !== expected.amountMinor || execution.currency !== expected.currency
      || execution.initiatedByUserId !== expected.initiatedByUserId || execution.createdAt.getTime() !== expected.createdAt.getTime())))
    throw new Error("Refund execution request changed");
}
function summary(execution: RefundExecutionEntity): RefundStatus {
  if (execution.terminalResult === "succeeded") return "succeeded";
  if (execution.terminalResult) return execution.terminalEvidence?.startsWith("retryable:") ? "pending_retry" : "failed";
  return execution.status === "uncertain" || execution.lastError ? "pending_retry" : "pending";
}

async function claimExecution(manager: EntityManager, refund: payments.ProcessingRefund, actorId: string | null,
  allowReplacement: boolean): Promise<ClaimResult> {
  // An abandoned change released this obligation; it is never processed again.
  if (refund.status === "voided") return { outcome: "terminal", status: "voided", notice: null };
  const history = await executions.listRefundExecutions(manager, refund.id);
  let execution = await executions.findUnresolvedRefundExecution(manager, refund.id) ?? history.at(-1);
  if (execution) verifyExecution(refund, execution);
  const retryable = execution?.terminalEvidence?.startsWith("retryable:") ?? false;
  if (retryable && execution?.completedAt && Date.now() - execution.completedAt.getTime() < 60 * 60 * 1000)
    return { outcome: "busy", status: "pending_retry" };
  if (execution?.terminalResult === "succeeded" || execution?.terminalResult && !allowReplacement && !retryable) {
    const status = summary(execution);
    await payments.writeRefundStatus(manager, refund.id, status);
    return { outcome: "terminal", status, notice: await refundFailureNotice(manager, refund, refund.status, status) };
  }
  if (!execution || execution.terminalResult) {
    const id = randomUUID();
    execution = (await executions.allocateRefundExecution(manager, {
      id, refundId: refund.id, provider: refund.provider, providerPaymentId: refund.provider_payment_id,
      amountMinor: refund.amount_minor, currency: z.enum(["EUR", "USD", "GBP", "RON", "CHF"]).parse(refund.currency),
      idempotencyKey: `court-refund-execution-${id}`, initiatedByUserId: actorId, createdAt: new Date(),
    })).execution;
  }
  const token = randomUUID();
  const identity = { refundId: refund.id, executionId: execution.id, token };
  if (!await executions.claimRefundExecution(manager, { ...identity, leaseUntil: new Date(Date.now() + refundExecutionLeaseMilliseconds) }))
    return { outcome: "busy", status: summary(execution) };
  execution = await executions.lockRefundExecution(manager, identity);
  await payments.writeRefundStatus(manager, refund.id, summary(execution));
  return { outcome: "ready", claim: { token, actorId, bookingId: refund.booking_id, refund, execution } };
}

export async function prepareAutomaticRefund(id: string): Promise<ClaimResult> {
  return inTransaction(async manager => {
    const source = await payments.discoverRefundBooking(manager, id);
    const context = source ? await lockAggregate(manager, source.booking_id, source.payment_attempt_id, id) : null;
    if (!context?.refund) throw new Error("Refund missing");
    await verifyRefund(manager, context.refund);
    return claimExecution(manager, context.refund, null, false);
  });
}

// An exact verified capture whose checkout or modification had already ended
// is returned automatically. Amount mismatches and other evidence problems are
// not refundable here and stay visible for investigation.
export async function prepareLateCaptureCompensation(eventId: string): Promise<string | null> {
  return inTransaction(async manager => {
    const attemptId = await payments.discoverEventAttempt(manager, eventId);
    const bookingId = attemptId ? await payments.findSettlementBookingId(manager, attemptId) : null;
    if (!attemptId || !bookingId) return null;
    const context = await lockAggregate(manager, bookingId, attemptId);
    if (!context) return null;
    const { payment, booking, reservation, events } = context;
    const event = events.find(e => e.provider === "stripe" && e.event_id === eventId);
    if (payment.provider !== "stripe" || payment.method !== "online" || !payment.provider_payment_id
      || !event?.reconciliation_required || !refundableLateCapture(event, payment, booking.status, reservation.status)) return null;
    let refund = context.refund;
    if (refund && !refundFinancialSnapshotMatches(refund, payment)) return null;
    if (!refund) {
      const adjustment = payment.adjustment_id ? await findAdjustment(manager, payment.adjustment_id) : null;
      if (payment.adjustment_id && (!adjustment || adjustment.bookingId !== bookingId)) throw new Error("Refund adjustment context changed");
      const [refundId] = await allocateBookingRefund(manager, { bookingId, actorId: null,
        operationKey: adjustment?.id ?? "cancellation", amount: payment.amount_minor, onlyAttemptId: payment.id,
        adjustmentId: adjustment?.id, reason: adjustment ? "failed_adjustment_compensation" : "late_capture_compensation",
        contextRevisionId: adjustment?.baseRevisionId ?? (await findInitialRevision(manager, bookingId)).id });
      if (!refundId) throw new Error("Refund request missing");
      refund = await payments.lockRefundForProcessing(manager, { id: refundId });
      if (!refund) throw new Error("Refund request missing");
    }
    await verifyRefund(manager, refund);
    if (refund.status === "succeeded") {
      // Verified completion already returned the money; close the review flag.
      await payments.writeRefundEventResolution(manager, resolvableRefundEvents(context, payment.id), payment.id, null);
      return null;
    }
    return refund.status === "pending" || refund.status === "pending_retry" ? refund.id : null;
  });
}

async function lockedClaim(manager: EntityManager, claim: RefundExecutionClaim) {
  const context = await lockAggregate(manager, claim.bookingId, claim.refund.payment_attempt_id, claim.refund.id);
  const refund = context?.refund;
  if (!context || !refund || !sameRefundSnapshot(refund, claim.refund)) throw new Error("Refund financial evidence changed");
  await verifyRefund(manager, refund);
  const identity = { refundId: refund.id, executionId: claim.execution.id, token: claim.token };
  const execution = await executions.lockRefundExecution(manager, identity);
  verifyExecution(refund, execution, claim.execution);
  return { context, refund, identity, execution };
}

export async function initiateRefundExecution(claim: RefundExecutionClaim) {
  return inTransaction(async manager => {
    const { refund, identity, execution } = await lockedClaim(manager, claim);
    if (execution.terminalResult) return { outcome: "terminal" as const, status: summary(execution) };
    if (!await executions.ownsRefundExecutionLease(manager, identity)) throw new Error("Stale refund execution lease");
    // A dispatched execution first looks for the provider refund. Only inside the
    // idempotency window may an unfound request be re-sent with its exact key.
    const operation: RefundDispatchOperation = execution.status === "ready" ? "create"
      : execution.dispatchInitiatedAt && Date.now() - execution.dispatchInitiatedAt.getTime() < refundReplayWindowMilliseconds
        ? "replay" : "recover";
    if (operation === "create") {
      await executions.recordRefundDispatch(manager, { ...identity, initiatedAt: new Date() });
      await payments.writeRefundStatus(manager, refund.id, "pending");
    }
    return { outcome: "dispatch" as const, operation, execution: await executions.lockRefundExecution(manager, identity) };
  });
}

export async function commitRefundExecution(claim: RefundExecutionClaim, observation: RefundObservation): Promise<{
  status: RefundStatus; notice: BookingEmailEvent | null }> {
  return inTransaction(async manager => {
    const { context, refund, identity, execution } = await lockedClaim(manager, claim);
    const current = execution.leaseToken === claim.token;
    const checkedAt = new Date();
    if (observation.kind === "verified") {
      const providerRefundId = z.string().min(1).max(255).parse(observation.providerRefundId);
      if (observation.status === "pending")
        await executions.recordRefundProviderIdentity(manager, { ...identity, providerRefundId, checkedAt });
      else await executions.recordRefundTerminalResult(manager, { ...identity, providerRefundId, result: observation.status,
        evidence: observation.status === "succeeded" ? "provider_refund_succeeded"
          : `${observation.retryable ? "retryable:" : "external_resolution:"}${observation.failureReason ?? "provider_refund_failed"}`, completedAt: checkedAt });
    } else {
      const evidence = observation.evidence;
      if (evidence.providerRefundId && evidence.kind !== "evidence_mismatch") await executions.recordRefundProviderIdentity(manager, { ...identity,
        providerRefundId: z.string().min(1).max(255).parse(evidence.providerRefundId), checkedAt });
      if (evidence.kind === "request_rejected") await executions.recordRefundTerminalResult(manager, { ...identity,
        result: "rejected", providerRefundId: null, evidence: `${evidence.retryable ? "retryable:" : "external_resolution:"}${evidence.failureReason ?? "provider_request_rejected"}`, completedAt: checkedAt });
      else if (["uncertain", "not_found", "evidence_mismatch"].includes(evidence.kind))
        await executions.recordRefundUncertainty(manager, { ...identity, evidence: evidence.kind, observedAt: checkedAt });
    }
    let updated = await executions.lockRefundExecution(manager, identity);
    if (current && !updated.terminalResult) {
      await executions.recordRefundExecutionCheck(manager, { ...identity, checkedAt, releaseLease: true,
        lastError: observation.kind === "verified" ? null
          : observation.evidence.kind === "not_found" ? "unresolved_after_idempotency_window"
          : observation.evidence.kind === "evidence_mismatch" ? "unresolved_provider_evidence" : observation.evidence.kind });
      updated = await executions.lockRefundExecution(manager, identity);
    }
    // Historical terminal truth survives stale claims, but a stale nonterminal
    // check cannot change the obligation summary or the current worker's state.
    // A voided obligation (abandoned change) keeps that status permanently.
    if (refund.status !== "voided" && (current || updated.terminalResult === "succeeded")) {
      const latest = (await executions.listRefundExecutions(manager, refund.id)).at(-1);
      if (!latest) throw new Error("Refund execution missing");
      const status = summary(latest);
      await payments.writeRefundStatus(manager, refund.id, status);
      // Full verified compensation of an ended request's capture closes its review flag.
      if (status === "succeeded" && refund.amount_minor === context.payment.amount_minor)
        await payments.writeRefundEventResolution(manager,
        resolvableRefundEvents(context, context.payment.id), context.payment.id, claim.actorId);
      // Missing evidence after the safe replay window is explicitly unresolved;
      // preserve the obligation and execution and continue evidence-only checks.
      const unresolved = observation.kind === "error" && ["not_found", "evidence_mismatch"].includes(observation.evidence.kind);
      const notice = await refundFailureNotice(manager, refund, unresolved ? "pending" : refund.status, unresolved ? "failed" : status);
      return { status, notice };
    }
    return { status: refund.status, notice: null };
  });
}
