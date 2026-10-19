import "server-only";
import type { EntityManager } from "typeorm";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { applyCapturedBookingAdjustment } from "@/lib/bookings/commands";
import { BookingRevisionFenceError } from "@/lib/db/repositories/booking-revisions.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { allocateBookingRefund } from "./financials";
import { recordBookingFinancialException } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { findBookingCancellationNotice } from "@/lib/db/repositories/bookings.repository";
import type { OnlinePaymentEvent } from "./providers/types";

// The existing settlement service owns all aggregate locks and receipt handling.
export async function settleAdjustment(manager: EntityManager, input: {
  attempt: NonNullable<Awaited<ReturnType<typeof payments.lockSettlementAttempt>>>;
  event: OnlinePaymentEvent | null; outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled";
  providerPaymentId: string; mismatch: boolean | null;
}): Promise<{ result: payments.ProviderReceipt["settlement_result"]; refundIds: string[];
  abandonProviderPayment: boolean }> {
  const { attempt } = input;
  const ended = { refundIds: [] as string[], abandonProviderPayment: false };
  const adjustment = attempt.adjustment_id ? await adjustments.findAdjustment(manager, attempt.adjustment_id) : null;
  if (!adjustment || adjustment.bookingId !== attempt.booking_id || input.mismatch)
    return { ...ended, result: "amount_mismatch" as const };
  const now = new Date(await reservations.readReservationClockTime(manager));
  // A delayed decline from an earlier card attempt cannot undo authorization
  // already accepted for capture. Only provider evidence resolves that operation.
  if (input.outcome === "retryable_failed" && adjustment.captureAcceptedAt !== null
    && adjustment.status === "pending" && attempt.status === "pending")
    return { ...ended, result: "pending" as const };
  // A decline is retryable only while the customer still holds the checkout
  // capability and the cutoff has not passed. The payment is no longer in flight.
  if (input.outcome === "retryable_failed" && adjustment.status === "pending" && now < adjustment.expiresAt
    && attempt.status === "pending" && attempt.checkout_capability) {
    await adjustments.resetAdjustmentLease(manager, adjustment.id);
    return { ...ended, result: "pending" as const };
  }
  if (input.outcome !== "succeeded") {
    if (attempt.status === "succeeded" || adjustment.status === "applied")
      return { ...ended, result: "succeeded" as const };
    const state = adjustment.status === "cancelled" ? "cancelled" : now >= adjustment.expiresAt ? "expired" : "cancelled";
    await adjustments.updateAdjustment(manager, adjustment.id, state);
    await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
    if (attempt.status === "pending" || input.outcome === "cancelled" && ["expired", "failed"].includes(attempt.status))
      await payments.updateSettlementAttempt(manager, attempt.id, {
        status: input.outcome === "cancelled" ? "cancelled" : "failed",
        providerPaymentId: input.providerPaymentId, deadline: null });
    // A failed intent could otherwise be confirmed again; cancel it after commit.
    return { ...ended, result: state, abandonProviderPayment: input.outcome !== "cancelled" };
  }
  // Record authoritative capture even after expiry/cancellation. Original
  // attempts are never modified to simulate an additional charge.
  const firstCapture = attempt.status !== "succeeded";
  if (attempt.status !== "succeeded") await payments.updateSettlementAttempt(manager, attempt.id, { status: "succeeded", providerPaymentId: input.providerPaymentId, deadline: null });
  if (adjustment.status === "applied") return { ...ended, result: "succeeded" as const };
  // Timely acceptance authorizes completion of the same capture even after
  // grace, including zero-fragment proposals. Unaccepted late success is invalid.
  const accepted = adjustment.captureAcceptedAt !== null;
  const deadline = accepted ? null : adjustment.expiresAt;
  const timely = deadline === null || now < deadline;
  await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
  if (adjustment.status === "pending" && timely) {
    await manager.query("SAVEPOINT booking_adjustment_apply");
    let applied: Awaited<ReturnType<typeof applyCapturedBookingAdjustment>> | null = null;
    try { applied = await applyCapturedBookingAdjustment(manager, adjustment, attempt.id, deadline); }
    catch (error) {
      const failure = normalizeDatabaseError(error);
      if (!(error instanceof BookingRevisionFenceError) && !(failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")) throw error;
      await manager.query("ROLLBACK TO SAVEPOINT booking_adjustment_apply");
    }
    await manager.query("RELEASE SAVEPOINT booking_adjustment_apply");
    if (applied?.result.ok) {
      await adjustments.updateAdjustment(manager, adjustment.id, "applied");
      return { ...ended, result: "succeeded" as const };
    }
    await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
  } else if (adjustment.status === "pending") await adjustments.updateAdjustment(manager, adjustment.id, "expired");
  const refundIds = await allocateBookingRefund(manager, { bookingId: adjustment.bookingId,
    amount: attempt.amount_minor, operationKey: adjustment.id, adjustmentId: adjustment.id,
    actorId: null, onlyAttemptId: attempt.id, reason: "failed_adjustment_compensation",
    contextRevisionId: adjustment.baseRevisionId });
  // The customer paid but the change could not be applied: record the exception
  // once, on the first verified capture. The compensation refund proceeds automatically.
  const revision = firstCapture ? await findBookingCancellationNotice(manager, adjustment.bookingId) : null;
  if (revision) await recordBookingFinancialException(manager, { key: `payment:${attempt.id}:modification_failed`,
    bookingId: attempt.booking_id, revisionId: revision.id, kind: "surcharge_unapplied",
    adjustmentId: adjustment.id, paymentAttemptId: attempt.id });
  return { ...ended, result: "expired" as const, refundIds };
}

// Resuming retrieves the registered intent, never creates another one. The
// authenticated recovery path can reissue the narrowly scoped checkout capability.
