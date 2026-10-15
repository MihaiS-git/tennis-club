import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { inTransaction } from "@/lib/db/transaction";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as executions from "@/lib/db/repositories/refund-executions.repository";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import type { RefundExecutionEntity } from "@/lib/db/entities/refund-execution.entity";
import { findBookingForUpdate } from "@/lib/db/repositories/bookings.repository";
import { findInitialRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import { findReservationForUpdate } from "@/lib/db/repositories/reservations.repository";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { refundObligationTotal } from "./refund-allocation";
import { allocateBookingRefund } from "./financials";
import { refundFinancialSnapshotMatches, paymentHasCapturedEvidence, sameRefundSnapshot } from "./refund-integrity";
import { refundableLateCapture, refundRetryEligible, resolvableRefundEvents } from "./providers/stripe/refund-policy";
import type { RefundProviderFailure } from "./providers/types";
import type { RefundStatus } from "./refunds";

export type RefundExecutionClaim = {
  token: string; actorId: string | null; bookingId: string; refund: payments.ProcessingRefund; execution: RefundExecutionEntity;
};
type ClaimResult = { outcome: "ready"; claim: RefundExecutionClaim }
  | { outcome: "busy"; status: RefundStatus } | { outcome: "terminal"; status: RefundStatus };
type Preparation = { outcome: "unavailable" | "already_refunded" | "busy" }
  | { outcome: "ready"; bookingId: string; claim: RefundExecutionClaim }
  | { outcome: "resolved"; bookingId: string; refundId: string };
export type RefundObservation = { kind: "verified"; status: "pending" | "succeeded" | "failed"; providerRefundId: string }
  | { kind: "error"; evidence: RefundProviderFailure };
const refundExecutionLeaseMilliseconds = 5 * 60 * 1000;

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
  if (!payment || refundObligationTotal(obligations) > payment.amount_minor || !refundFinancialSnapshotMatches(refund, payment)
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
  if (execution.terminalResult) return "failed";
  return execution.status === "uncertain" || execution.lastError ? "pending_retry" : "pending";
}

async function claimExecution(manager: EntityManager, refund: payments.ProcessingRefund, actorId: string | null,
  allowReplacement: boolean): Promise<ClaimResult> {
  const history = await executions.listRefundExecutions(manager, refund.id);
  let execution = await executions.findUnresolvedRefundExecution(manager, refund.id) ?? history.at(-1);
  if (execution) verifyExecution(refund, execution);
  if (execution?.terminalResult === "succeeded" || execution?.terminalResult && !allowReplacement) {
    const status = summary(execution);
    await payments.writeRefundStatus(manager, refund.id, status);
    return { outcome: "terminal", status };
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

export async function prepareAdminRefund(kind: "retry" | "reconcile", id: string, actorId: string): Promise<Preparation> {
  return inTransaction(async manager => {
    const source = kind === "retry" ? await payments.discoverRefundBooking(manager, id) : null;
    const attemptId = source?.payment_attempt_id ?? (kind === "reconcile" ? await payments.discoverEventAttempt(manager, id) : null);
    const bookingId = source?.booking_id ?? (attemptId ? await payments.findSettlementBookingId(manager, attemptId) : null);
    if (!bookingId || !attemptId) return { outcome: "unavailable" };
    const context = await lockAggregate(manager, bookingId, attemptId, kind === "retry" ? id : undefined);
    if (!context) return { outcome: "unavailable" };
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active" || !actor.roles.includes("admin")) throw new Error("Admin authorization changed");
    const { payment, booking, reservation, events } = context;
    let refund = context.refund;
    const event = kind === "reconcile" ? events.find(e => e.provider === "stripe" && e.event_id === id) : null;
    const late = events.some(e => refundableLateCapture(e, payment, booking.status, reservation.status));
    if (payment.provider !== "stripe" || payment.method !== "online" || !payment.provider_payment_id
      || (!(payment.status === "succeeded" && (booking.status === "cancelled" || kind === "retry" && refund?.operation_key !== "cancellation")) && !late)
      || (kind === "reconcile" && (!event || !refundableLateCapture(event, payment, booking.status, reservation.status)))
      || (refund && !refundFinancialSnapshotMatches(refund, payment))) return { outcome: "unavailable" };
    if (kind === "retry" && (!refund || refund.id !== id || !refundRetryEligible(refund.status, refund.provider) && refund.status !== "succeeded"))
      return { outcome: "unavailable" };
    if (kind === "reconcile" && (!event || (!event.reconciliation_required && refund?.status !== "succeeded")))
      return { outcome: "unavailable" };
    if (!refund) {
      const adjustment = payment.adjustment_id ? await findAdjustment(manager, payment.adjustment_id) : null;
      if (payment.adjustment_id && (!adjustment || adjustment.bookingId !== bookingId)) throw new Error("Refund adjustment context changed");
      const [refundId] = await allocateBookingRefund(manager, { bookingId, actorId,
        operationKey: adjustment?.id ?? "cancellation", amount: payment.amount_minor, onlyAttemptId: payment.id,
        adjustmentId: adjustment?.id, reason: adjustment ? "failed_adjustment_compensation" : "late_capture_compensation",
        contextRevisionId: adjustment?.baseRevisionId ?? (await findInitialRevision(manager, bookingId)).id });
      if (!refundId) throw new Error("Refund request missing");
      refund = await payments.lockRefundForProcessing(manager, { id: refundId });
      if (!refund) throw new Error("Refund request missing");
    }
    await verifyRefund(manager, refund);
    const prepared = await claimExecution(manager, refund, actorId, true);
    if (prepared.outcome === "busy") return { outcome: "busy" };
    if (prepared.outcome === "terminal") {
      if (kind === "retry") return { outcome: "already_refunded" };
      await payments.writeRefundEventResolution(manager, resolvableRefundEvents(context, payment.id), payment.id, actorId);
      return { outcome: "resolved", bookingId, refundId: refund.id };
    }
    return { outcome: "ready", bookingId, claim: prepared.claim };
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
    const operation = execution.status === "ready" ? "create" as const : "recover" as const;
    if (operation === "create") {
      await executions.recordRefundDispatch(manager, { ...identity, initiatedAt: new Date() });
      await payments.writeRefundStatus(manager, refund.id, "pending");
    }
    return { outcome: "dispatch" as const, operation, execution };
  });
}

export async function commitRefundExecution(claim: RefundExecutionClaim, observation: RefundObservation): Promise<RefundStatus> {
  return inTransaction(async manager => {
    const { context, refund, identity, execution } = await lockedClaim(manager, claim);
    const current = execution.leaseToken === claim.token;
    const checkedAt = new Date();
    if (observation.kind === "verified") {
      const providerRefundId = z.string().min(1).max(255).parse(observation.providerRefundId);
      if (observation.status === "pending")
        await executions.recordRefundProviderIdentity(manager, { ...identity, providerRefundId, checkedAt });
      else await executions.recordRefundTerminalResult(manager, { ...identity, providerRefundId, result: observation.status,
        evidence: observation.status === "succeeded" ? "provider_refund_succeeded" : "provider_refund_failed", completedAt: checkedAt });
    } else {
      const evidence = observation.evidence;
      if (evidence.providerRefundId) await executions.recordRefundProviderIdentity(manager, { ...identity,
        providerRefundId: z.string().min(1).max(255).parse(evidence.providerRefundId), checkedAt });
      if (evidence.kind === "request_rejected") await executions.recordRefundTerminalResult(manager, { ...identity,
        result: "rejected", providerRefundId: null, evidence: "provider_request_rejected", completedAt: checkedAt });
      else if (["uncertain", "not_found", "evidence_mismatch"].includes(evidence.kind))
        await executions.recordRefundUncertainty(manager, { ...identity, evidence: evidence.kind, observedAt: checkedAt });
    }
    let updated = await executions.lockRefundExecution(manager, identity);
    if (current && !updated.terminalResult) {
      await executions.recordRefundExecutionCheck(manager, { ...identity, checkedAt, releaseLease: true,
        lastError: observation.kind === "verified" ? null : observation.evidence.kind });
      updated = await executions.lockRefundExecution(manager, identity);
    }
    // Historical terminal truth survives stale claims, but a stale nonterminal
    // check cannot change the obligation summary or the current worker's state.
    if (current || updated.terminalResult === "succeeded") {
      const latest = (await executions.listRefundExecutions(manager, refund.id)).at(-1);
      if (!latest) throw new Error("Refund execution missing");
      const status = summary(latest);
      await payments.writeRefundStatus(manager, refund.id, status);
      if (status === "succeeded" && (claim.actorId !== null || context.payment.adjustment_id && refund.amount_minor === context.payment.amount_minor))
        await payments.writeRefundEventResolution(manager,
        resolvableRefundEvents(context, context.payment.id), context.payment.id, claim.actorId);
      return status;
    }
    return refund.status;
  });
}
