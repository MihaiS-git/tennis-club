import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { refundFinancialSnapshotMatches, paymentHasCapturedEvidence, sameRefundSnapshot } from "./refund-integrity";
import type { EntityManager } from "typeorm";
import { inTransaction } from "@/lib/db/transaction";
import * as payments from "@/lib/db/repositories/payments.repository";
import { lockSettlementBooking } from "@/lib/db/repositories/bookings.repository";
import { findReservationForUpdate } from "@/lib/db/repositories/reservations.repository";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { refundableLateCapture, refundRetryEligible, resolvableRefundEvents } from "./providers/stripe/refund-policy";

export type AdminRefundClaim = {
  token: string; actorId: string; bookingId: string; refund: payments.ProcessingRefund;
};
type Preparation = { outcome: "unavailable" | "already_refunded" | "busy" }
  | { outcome: "ready"; bookingId: string; claim: AdminRefundClaim }
  | { outcome: "resolved"; bookingId: string };

// The caller discovers identity without locks. All aggregate commands then use
// booking -> reservation -> selected attempt -> ordered events -> refund.
async function lockAggregate(manager: EntityManager, bookingId: string, attemptId: string) {
  const booking = await lockSettlementBooking(manager, bookingId);
  if (!booking) return null;
  const reservation = await findReservationForUpdate(manager, booking.reservation_id);
  const payment = await payments.lockSettlementAttempt(manager, attemptId);
  if (!reservation || !payment || payment.booking_id !== booking.id) return null;
  const events = await payments.lockRefundEventsForAttempt(manager, payment.id);
  const refund = await payments.lockRefundForProcessing(manager, { bookingId });
  return { booking, reservation, payments: [payment], payment, events, refund };
}

export async function prepareAdminRefund(kind: "retry" | "reconcile", id: string, actorId: string): Promise<Preparation> {
  return inTransaction(async manager => {
    const source = kind === "retry" ? await payments.discoverRefundBooking(manager, id) : null;
    const attemptId = source?.payment_attempt_id ?? (kind === "reconcile" ? await payments.discoverEventAttempt(manager, id) : null);
    const bookingId = source?.booking_id ?? (attemptId ? await payments.findSettlementBookingId(manager, attemptId) : null);
    if (!bookingId || !attemptId) return { outcome: "unavailable" };
    const context = await lockAggregate(manager, bookingId, attemptId);
    if (!context) return { outcome: "unavailable" };
    const actor = await lockReservationActorFacts(manager, actorId);
    if (actor?.status !== "active" || !actor.roles.includes("admin")) throw new Error("Admin authorization changed");
    const { payment, booking, reservation, events } = context;
    let refund = context.refund;
    const event = kind === "reconcile" ? events.find(e => e.provider === "stripe" && e.event_id === id) : null;
    const late = events.some(e => refundableLateCapture(e, payment, booking.status, reservation.status));
    if (payment.provider !== "stripe" || payment.method !== "online" || !payment.provider_payment_id
      || (!(payment.status === "succeeded" && booking.status === "cancelled") && !late)
      || (kind === "reconcile" && (!event || !refundableLateCapture(event, payment, booking.status, reservation.status)))
      || (refund && !refundFinancialSnapshotMatches(refund, payment))) return { outcome: "unavailable" };
    if (kind === "retry" && refund?.status === "succeeded") return { outcome: "already_refunded" };
    if (kind === "retry" && (!refund || refund.id !== id || !refundRetryEligible(refund.status, refund.provider)))
      return { outcome: "unavailable" };
    if (kind === "reconcile" && (!event || (!event.reconciliation_required && refund?.status !== "succeeded")))
      return { outcome: "unavailable" };
    if (!refund) {
      const refundId = await payments.insertBookingRefundRequest(manager, bookingId, actorId, {
        id: payment.id, provider: "stripe", provider_payment_id: payment.provider_payment_id,
        amount_minor: payment.amount_minor, currency: payment.currency,
      });
      refund = await payments.lockRefundForProcessing(manager, { id: refundId });
      if (!refund) throw new Error("Refund request missing");
    }
    if (refund.status === "succeeded") {
      await payments.writeRefundEventResolution(manager, resolvableRefundEvents(context, payment.id), payment.id, actorId);
      return { outcome: "resolved", bookingId };
    }
    // Evaluate the wall clock after every potentially blocking lock, including
    // the actor fence. Keep the lossless deadline projection for execution.
    refund = await payments.lockRefundForProcessing(manager, { id: refund.id });
    if (!refund) throw new Error("Refund request missing");
    if (refund.lease_busy) return { outcome: "busy" };
    const token = randomUUID();
    await payments.writeRefundLease(manager, refund.id, token, actorId);
    const claimed = await payments.lockRefundForProcessing(manager, { id: refund.id });
    if (!claimed) throw new Error("Refund lease missing");
    return { outcome: "ready", bookingId, claim: { token, actorId, bookingId, refund: claimed } };
  });
}

async function verifyAutomaticRefund(manager: EntityManager, refund: payments.ProcessingRefund) {
  const { payment, events } = await payments.findRefundCaptureEvidence(manager, refund.payment_attempt_id);
  if (!payment || !refundFinancialSnapshotMatches(refund, payment) || !paymentHasCapturedEvidence(payment, events))
    throw new Error("Refund financial evidence changed");
}
export async function prepareAutomaticRefund(id: string) {
  return inTransaction(async manager => {
    const refund = await payments.lockRefundForProcessing(manager, { id });
    if (refund) await verifyAutomaticRefund(manager, refund);
    return refund;
  });
}

type ProviderResult = {
  status: payments.ProcessingRefund["status"]; providerRefundId: string | null; lastError: string | null;
};
function compatibleReference(refund: payments.ProcessingRefund, reference: string | null) {
  if (refund.provider_refund_id && reference && refund.provider_refund_id !== reference)
    throw new Error("Conflicting provider refund identity");
}

const providerResultSchema = z.strictObject({
  status: z.enum(["pending", "pending_retry", "succeeded", "failed"]),
  providerRefundId: z.string().min(1).max(255).nullable(), lastError: z.string().nullable(),
});

export async function commitAutomaticRefund(id: string, result: ProviderResult, expected?: payments.ProcessingRefund) {
  result = providerResultSchema.parse(result);
  return inTransaction(async manager => {
    const refund = await payments.lockRefundForProcessing(manager, { id });
    if (!refund) throw new Error("Refund missing");
    await verifyAutomaticRefund(manager, refund);
    if (expected && !sameRefundSnapshot(refund, expected)) throw new Error("Refund financial evidence changed");
    compatibleReference(refund, result.providerRefundId);
    if (refund.status === "succeeded" || refund.status === "failed") return refund.status;
    await payments.writeRefundResult(manager, id, { ...result, clearLease: false });
    return result.status;
  });
}

export async function commitAdminRefund(claim: AdminRefundClaim, result: ProviderResult) {
  result = providerResultSchema.parse(result);
  return inTransaction(async manager => {
    const source = await payments.discoverRefundBooking(manager, claim.refund.id);
    if (!source || source.booking_id !== claim.bookingId || source.payment_attempt_id !== claim.refund.payment_attempt_id)
      throw new Error("Refund aggregate changed");
    const context = await lockAggregate(manager, source.booking_id, source.payment_attempt_id);
    const refund = context?.refund;
    if (!context || !refund || refund.id !== claim.refund.id || !refundFinancialSnapshotMatches(refund, context.payment)
      || !sameRefundSnapshot(refund, claim.refund)
      || !paymentHasCapturedEvidence(context.payment, context.events))
      throw new Error("Refund financial evidence changed");
    if (!claim.token || refund.admin_lease_token !== claim.token || refund.admin_lease_actor_id !== claim.actorId)
      throw new Error("Stale refund lease");
    compatibleReference(refund, result.providerRefundId);
    const authoritative = refund.status === "succeeded"
      ? { status: refund.status, providerRefundId: refund.provider_refund_id, lastError: null } : result;
    await payments.writeRefundResult(manager, refund.id, { ...authoritative, clearLease: true });
    if (authoritative.status === "succeeded") {
      await payments.writeRefundEventResolution(manager, resolvableRefundEvents(context, refund.payment_attempt_id),
        refund.payment_attempt_id, claim.actorId);
    }
    return authoritative.status;
  });
}
