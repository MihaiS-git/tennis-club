import "server-only";
import type { EntityManager } from "typeorm";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { applyCapturedBookingAdjustment } from "@/lib/bookings/commands";
import { BookingRevisionFenceError } from "@/lib/db/repositories/booking-revisions.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { allocateBookingRefund } from "./financials";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import type { OnlinePaymentEvent } from "./providers/types";

// The existing settlement service owns all aggregate locks and receipt handling.
export async function settleAdjustment(manager: EntityManager, input: {
  attempt: NonNullable<Awaited<ReturnType<typeof payments.lockSettlementAttempt>>>;
  event: OnlinePaymentEvent | null; outcome: "succeeded" | "failed" | "retryable_failed" | "cancelled";
  providerPaymentId: string; mismatch: boolean | null;
}): Promise<{ result: payments.ProviderReceipt["settlement_result"]; refundIds: string[]; notification: BookingEmailEvent | null }> {
  const { attempt } = input;
  const adjustment = attempt.adjustment_id ? await adjustments.findAdjustment(manager, attempt.adjustment_id) : null;
  if (!adjustment || adjustment.bookingId !== attempt.booking_id || input.mismatch)
    return { result: "amount_mismatch" as const, refundIds: [], notification: null };
  const now = new Date(await reservations.readReservationClockTime(manager));
  if (input.outcome === "retryable_failed" && adjustment.status === "pending" && now < adjustment.expiresAt)
    return { result: "pending" as const, refundIds: [], notification: null };
  if (input.outcome !== "succeeded") {
    if (attempt.status === "succeeded" || adjustment.status === "applied")
      return { result: "succeeded" as const, refundIds: [], notification: null };
    const state = adjustment.status === "cancelled" ? "cancelled" : now >= adjustment.expiresAt ? "expired" : "cancelled";
    await adjustments.updateAdjustment(manager, adjustment.id, state);
    await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
    await payments.updateSettlementAttempt(manager, attempt.id, { status: input.outcome === "cancelled" ? "cancelled" : state, providerPaymentId: input.providerPaymentId, deadline: null });
    return { result: state, refundIds: [], notification: null };
  }
  // Record authoritative capture even after expiry/cancellation. Original
  // attempts are never modified to simulate an additional charge.
  if (attempt.status !== "succeeded") await payments.updateSettlementAttempt(manager, attempt.id, { status: "succeeded", providerPaymentId: input.providerPaymentId, deadline: null });
  if (adjustment.status === "applied") return { result: "succeeded" as const, refundIds: [], notification: null };
  await adjustments.releaseAdjustmentHolds(manager, adjustment.id);
  if (adjustment.status === "pending" && now < adjustment.expiresAt) {
    await manager.query("SAVEPOINT booking_adjustment_apply");
    let applied: Awaited<ReturnType<typeof applyCapturedBookingAdjustment>> | null = null;
    try { applied = await applyCapturedBookingAdjustment(manager, adjustment, attempt.id); }
    catch (error) {
      const failure = normalizeDatabaseError(error);
      if (!(error instanceof BookingRevisionFenceError) && !(failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")) throw error;
      await manager.query("ROLLBACK TO SAVEPOINT booking_adjustment_apply");
    }
    await manager.query("RELEASE SAVEPOINT booking_adjustment_apply");
    if (applied?.result.ok) {
      await adjustments.updateAdjustment(manager, adjustment.id, "applied");
      return { result: "succeeded" as const, refundIds: [], notification: applied.notification };
    }
    await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
  } else if (adjustment.status === "pending") await adjustments.updateAdjustment(manager, adjustment.id, "expired");
  const refundIds = await allocateBookingRefund(manager, { bookingId: adjustment.bookingId,
    amount: attempt.amount_minor, operationKey: adjustment.id, adjustmentId: adjustment.id,
    actorId: null, onlyAttemptId: attempt.id, reason: "failed_adjustment_compensation",
    contextRevisionId: adjustment.baseRevisionId });
  return { result: "expired" as const, refundIds, notification: null };
}

// Resuming retrieves the registered intent, never creates another one. The
// authenticated recovery path can reissue the narrowly scoped checkout capability.
