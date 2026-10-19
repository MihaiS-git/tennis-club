import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { inTransaction } from "@/lib/db/transaction";
import { getDataSource } from "@/lib/db/data-source";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as executions from "@/lib/db/repositories/refund-executions.repository";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import type { RefundExecutionEntity } from "@/lib/db/entities/refund-execution.entity";
import { findBookingCancellationNotice, findBookingForUpdate } from "@/lib/db/repositories/bookings.repository";
import { findReservationForUpdate } from "@/lib/db/repositories/reservations.repository";
import { findAdjustment, listAdjustmentRefunds } from "@/lib/db/repositories/booking-adjustments.repository";
import { refundBackedOutcome } from "@/lib/bookings/domain";
import { recordBookingFinancialException } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { refundObligationTotal, reservingObligations } from "./refund-allocation";
import { refundFinancialSnapshotMatches, paymentHasCapturedEvidence, sameRefundSnapshot } from "./refund-integrity";
import { resolvableRefundEvents } from "./providers/stripe/refund-policy";
import type { RefundProviderFailure } from "./providers/types";
import type { RefundStatus } from "./refunds";

export type RefundExecutionClaim = {
  token: string; actorId: string | null; bookingId: string; refund: payments.ProcessingRefund; execution: RefundExecutionEntity;
};
type ClaimResult = { outcome: "ready"; claim: RefundExecutionClaim }
  | { outcome: "busy"; status: RefundStatus } | { outcome: "terminal"; status: RefundStatus; notice: boolean };
export type RefundObservation = { kind: "verified"; status: "pending" | "succeeded" | "failed"; providerRefundId: string; retryable?: boolean; failureReason?: string }
  | { kind: "error"; evidence: RefundProviderFailure };
type RefundDispatchOperation = "create" | "recover" | "replay";
const refundExecutionLeaseMilliseconds = 5 * 60 * 1000;
// Stripe retains idempotency keys for at least 24 hours. Within this margin an
// unconfirmed dispatched request may be re-sent with its exact stored key: Stripe
// returns the original refund if the first request executed, so no duplicate.
const refundReplayWindowMilliseconds = 23 * 60 * 60 * 1000;

// Execution evidence is write-once; a later provider failure of a succeeded
// refund is recorded on the writable check fields and decides the current status.
const reversedRefund = "provider_refund_reversed";

// Record exceptional financial outcomes atomically. Scheduled projection later
// creates the customer notice; no notification work belongs in this transaction.
// failed: definitive provider failure; unresolved: evidence missing beyond the safe
// replay window; reversed: Stripe failed a refund it had reported succeeded.
async function recordRefundException(manager: EntityManager, refund: payments.ProcessingRefund,
  cause: "failed" | "unresolved" | "reversed" | null): Promise<boolean> {
  if (!cause) return false;
  const revision = await findBookingCancellationNotice(manager, refund.booking_id);
  if (!revision) throw new Error("Refund exception revision missing");
  // The last definitive failure also commits the rejection evidence. Resolution
  // may run later or crash; it reuses this exact adjustment event identity.
  if (cause === "failed" && refund.adjustment_id
    && (refund.reason === "booking_cancellation" || refund.reason === "booking_price_reduction")) {
    const obligations = await listAdjustmentRefunds(manager, refund.adjustment_id);
    const outcome = refundBackedOutcome(obligations.map(obligation => obligation.status));
    if (outcome === "abandon") {
      const adjustment = await findAdjustment(manager, refund.adjustment_id);
      if (!adjustment) throw new Error("Refund adjustment missing");
      await recordBookingFinancialException(manager, { key: `adjustment:${adjustment.id}:abandoned`,
        bookingId: refund.booking_id, revisionId: revision.id, adjustmentId: adjustment.id,
        kind: adjustment.kind === "cancellation" ? "cancellation_rejected" : "modification_rejected" });
      // Rejection evidence is durable, but there is no outstanding refund alert.
      return false;
    }
    if (outcome !== "waiting") return false;
  }
  await recordBookingFinancialException(manager, { key: `refund:${refund.id}:${cause === "reversed" ? "reversed" : "exception"}`,
    bookingId: refund.booking_id, revisionId: revision.id, refundId: refund.id,
    kind: cause === "reversed" ? "refund_reversed" : cause === "unresolved" ? "refund_unresolved" : "refund_failed" });
  return true;
}

// Refund-only commands do not change occupancy. All paths use the same order:
// booking -> reservation -> selected attempt -> ordered receipts -> obligation -> execution.
async function lockAggregate(manager: EntityManager, bookingId: string, attemptId: string, refundId: string) {
  const booking = await findBookingForUpdate(manager, bookingId);
  if (!booking) return null;
  const reservation = await findReservationForUpdate(manager, booking.reservation_id);
  const payment = await payments.lockSettlementAttempt(manager, attemptId);
  if (!reservation || !payment || payment.booking_id !== booking.id) return null;
  await captures.lockCaptureReceiptsForAttempt(manager, payment.id);
  const events = await payments.lockRefundEventsForAttempt(manager, payment.id);
  const refund = await payments.lockRefundForProcessing(manager, { id: refundId });
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
// A reversed refund stays failed; replays keep that cause, so every check of it
// (webhook redelivery, Admin) reuses the single :reversed notice identity.
function failureCause(execution: RefundExecutionEntity, status: RefundStatus) {
  return execution.lastError === reversedRefund ? "reversed" as const : status === "failed" ? "failed" as const : null;
}
function summary(execution: RefundExecutionEntity): RefundStatus {
  if (execution.terminalResult === "succeeded") return execution.lastError === reversedRefund ? "failed" : "succeeded";
  if (execution.terminalResult) return execution.terminalEvidence?.startsWith("retryable:") ? "pending_retry" : "failed";
  return execution.status === "uncertain" || execution.lastError ? "pending_retry" : "pending";
}

async function claimExecution(manager: EntityManager, refund: payments.ProcessingRefund, actorId: string | null,
  retryRejected: boolean): Promise<ClaimResult> {
  // An abandoned change released this obligation; it is never processed again.
  if (refund.status === "voided") return { outcome: "terminal", status: "voided", notice: false };
  const history = await executions.listRefundExecutions(manager, refund.id);
  let execution = await executions.findUnresolvedRefundExecution(manager, refund.id) ?? history.at(-1);
  if (execution) verifyExecution(refund, execution);
  // Terminal provider results are final. Only an affirmative retryable rejection
  // (no money moved) may get a replacement execution, on explicit Admin request.
  const retryable = execution?.terminalEvidence?.startsWith("retryable:") ?? false;
  if (execution?.terminalResult && !(retryable && retryRejected)) {
    const status = summary(execution);
    await payments.writeRefundStatus(manager, refund.id, status);
    // Terminal replay is not a new occurrence. In particular do not recreate
    // historical exceptions whose delivery may have been deleted before cutover.
    return { outcome: "terminal", status, notice: false };
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

export async function prepareRefund(id: string, options: { actorId?: string; retryRejected?: boolean } = {}): Promise<ClaimResult> {
  return inTransaction(async manager => {
    const source = await payments.discoverRefundBooking(manager, id);
    const context = source ? await lockAggregate(manager, source.booking_id, source.payment_attempt_id, id) : null;
    if (!context?.refund) throw new Error("Refund missing");
    await verifyRefund(manager, context.refund);
    const claim = await claimExecution(manager, context.refund, options.actorId ?? null, options.retryRejected ?? false);
    // A distinct late capture event for a payment already fully refunded closes its review flag.
    if (claim.outcome === "terminal" && claim.status === "succeeded" && context.refund.amount_minor === context.payment.amount_minor)
      await payments.writeRefundEventResolution(manager, resolvableRefundEvents(context, context.payment.id),
        context.payment.id, options.actorId ?? null);
    return claim;
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
  status: RefundStatus; notice: boolean }> {
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
      const cause = unresolved ? "unresolved" : !execution.terminalResult ? failureCause(latest, status) : null;
      const notice = await recordRefundException(manager, refund, cause);
      return { status, notice };
    }
    return { status: refund.status, notice: false };
  });
}

// A signed refund.updated/refund.failed for a refund already recorded as
// succeeded: the caller re-read and verified the exact Stripe refund as failed.
// Historical success evidence is preserved; the obligation becomes failed, the
// customer is notified and Admin attention lists it. No replacement is created.
export async function recordProviderRefundReversal(refundId: string, providerRefundId: string): Promise<{
  status: RefundStatus; notice: boolean }> {
  return inTransaction(async manager => {
    const source = await payments.discoverRefundBooking(manager, refundId);
    const context = source ? await lockAggregate(manager, source.booking_id, source.payment_attempt_id, refundId) : null;
    if (!context?.refund) throw new Error("Refund missing");
    const refund = context.refund;
    const latest = (await executions.listRefundExecutions(manager, refund.id)).at(-1);
    if (!latest || latest.terminalResult !== "succeeded" || latest.providerRefundId !== providerRefundId)
      throw new Error("Refund reversal evidence does not match the recorded refund");
    if (latest.lastError === reversedRefund) return { status: "failed" as const, notice: false };
    await executions.recordRefundReversal(manager, { refundId: refund.id, executionId: latest.id,
      lastError: reversedRefund, checkedAt: new Date() });
    await payments.writeRefundStatus(manager, refund.id, "failed");
    return { status: "failed" as const, notice: await recordRefundException(manager, refund, "reversed") };
  });
}

// Read-only facts the refund webhook needs to re-read a completed refund at Stripe.
export async function completedRefundExecution(refundId: string) {
  const latest = (await executions.listRefundExecutions((await getDataSource()).manager, refundId)).at(-1);
  return latest?.terminalResult === "succeeded" && latest.providerRefundId && latest.lastError !== reversedRefund ? latest : null;
}
