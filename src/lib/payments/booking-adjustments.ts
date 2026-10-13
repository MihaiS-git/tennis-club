import "server-only";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { EntityManager } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { applyCapturedBookingAdjustment } from "@/lib/bookings/commands";
import type { BookingRescheduleResult } from "@/lib/bookings/reschedule";
import { processBookingRefund, type RefundStatus } from "./refunds";
import { onlinePaymentAdapter } from "./providers";
import { processOnlinePaymentEvent, settleOnlinePayment } from "./service";
import { startOnlineCheckout } from "./checkout";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import type { OnlinePaymentEvent } from "./providers/types";

function summarizeRefunds(statuses: RefundStatus[]): RefundStatus | undefined {
  return statuses.includes("failed") ? "failed" : statuses.includes("pending_retry") ? "pending_retry"
    : statuses.includes("pending") ? "pending" : statuses.length ? "succeeded" : undefined;
}

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
    catch { await manager.query("ROLLBACK TO SAVEPOINT booking_adjustment_apply"); }
    await manager.query("RELEASE SAVEPOINT booking_adjustment_apply");
    if (applied?.result.ok) {
      await adjustments.updateAdjustment(manager, adjustment.id, "applied");
      return { result: "succeeded" as const, refundIds: [], notification: applied.notification };
    }
    await adjustments.updateAdjustment(manager, adjustment.id, "unsuccessful");
  } else if (adjustment.status === "pending") await adjustments.updateAdjustment(manager, adjustment.id, "expired");
  const refundIds = await adjustments.allocateBookingRefund(manager, { bookingId: adjustment.bookingId,
    amount: attempt.amount_minor, operationKey: adjustment.id, adjustmentId: adjustment.id,
    actorId: null, onlyAttemptId: attempt.id });
  return { result: "expired" as const, refundIds, notification: null };
}

// Resuming retrieves the registered intent, never creates another one. The
// authenticated recovery path can reissue the narrowly scoped checkout capability.
export async function adjustmentPresentation(id: string) {
  const manager = (await getDataSource()).manager;
  const adjustment = await adjustments.findAdjustment(manager, id);
  const attempt = await adjustments.adjustmentAttempt(manager, id);
  if (!adjustment || !attempt) throw new Error("Payment adjustment unavailable");
  if (attempt.providerPaymentId && !["succeeded", "cancelled"].includes(attempt.status)) {
    try {
      const evidence = await (await onlinePaymentAdapter("stripe")).readPayment({ id: attempt.id, providerPaymentId: attempt.providerPaymentId });
      if (evidence.status === "succeeded" || evidence.status === "cancelled")
        await processOnlinePaymentEvent({ attemptId: attempt.id, provider: "stripe", providerPaymentId: attempt.providerPaymentId,
          eventId: `checkout-observation-${attempt.id}-${evidence.status}`, outcome: evidence.status,
          amountMinor: evidence.amountMinor, currency: evidence.currency });
    } catch { /* Leave uncertain provider outcomes recoverable. */ }
  }
  if (["cancelled", "expired", "unsuccessful"].includes(adjustment.status) && !["succeeded","cancelled"].includes(attempt.status) && attempt.providerPaymentId) {
    try {
      const outcome = await (await onlinePaymentAdapter("stripe")).cancelPayment({ id: attempt.id, providerPaymentId: attempt.providerPaymentId });
      if (outcome === "cancelled") await settleOnlinePayment({ attemptId: attempt.id, provider: "stripe", providerPaymentId: attempt.providerPaymentId, outcome });
    } catch { /* Preserve uncertainty and retry the same intent on recovery. */ }
  }
  const status = await readAdjustmentStatus(manager, id);
  if (status.status !== "pending_payment") return null;
  if (adjustment.status !== "pending" || adjustment.expiresAt.getTime() <= Date.now()) return null;
  let checkout;
  if (!attempt.providerPaymentId) {
    try { checkout = await startOnlineCheckout(attempt.id); }
    catch {
      // A concurrent initializer may already have attached this same intent.
      const latest = await adjustments.adjustmentAttempt(manager, id);
      if (!latest?.providerPaymentId) throw new Error("Payment initialization needs recovery");
    }
  }
  if (!checkout) {
    const current = await adjustments.adjustmentAttempt(manager, id);
    if (!current?.providerPaymentId) throw new Error("Payment unavailable");
    const presentation = await (await onlinePaymentAdapter("stripe")).resumePayment({ id: current.id, providerPaymentId: current.providerPaymentId });
    const token = randomBytes(32).toString("hex");
    await inTransaction(async m => {
      await bookings.lockCheckoutBooking(m, current.bookingId);
      const locked = await payments.lockCheckoutAttempt(m, current.id);
      if (!locked || locked.providerPaymentId !== current.providerPaymentId || locked.adjustmentId !== id)
        throw new Error("Checkout reference changed");
      await payments.reissueCheckoutCapability(m,current.id,createHash("sha256").update(token).digest("hex"));
    });
    checkout = { attemptId: current.id, token, presentation };
  }
  return { totalAmountMinor: adjustment.newTotal, checkout, holdExpiresAt: adjustment.expiresAt.toISOString(),
    paymentUrl: `/book/adjustments/${id}?token=${checkout.token}` };
}
export async function finishBookingAdjustment(result: BookingRescheduleResult): Promise<BookingRescheduleResult> {
  if (!result.ok || !result.adjustmentId) return result;
  const recorded = await adjustments.listAdjustmentRefunds((await getDataSource()).manager,result.adjustmentId);
  const refundIds = result.refundIds ?? recorded.map(r=>r.id);
  const statuses = await Promise.all(refundIds.map(id => processBookingRefund(id)));
  if (result.adjustmentStatus !== "pending") return { ...result, refundIds, refundStatus: summarizeRefunds(statuses) };
  try {
    const presentation = await adjustmentPresentation(result.adjustmentId);
    if (presentation) return { ...result, ...presentation };
    const manager = (await getDataSource()).manager;
    const current = await adjustments.findAdjustment(manager, result.adjustmentId);
    const refunds = await adjustments.listAdjustmentRefunds(manager, result.adjustmentId);
    return { ...result, adjustmentStatus: current?.status ?? result.adjustmentStatus,
      refundStatus: summarizeRefunds(refunds.map(r => r.status)) };
  }
  catch { return result; } // Durable pending operation remains recoverable; never report a new booking as applied.
}
export async function readAdjustmentStatus(manager: EntityManager, id: string) {
  const adjustment = await adjustments.findAdjustment(manager, id);
  if (!adjustment) throw new Error("Adjustment unavailable");
  // Only the location mutex can release target holds. Polling uses that same lock.
  if (["pending","cancelled"].includes(adjustment.status) && adjustment.expiresAt.getTime() <= Date.now()) {
    const parent = await bookings.discoverBookingLocation(manager, adjustment.bookingId);
    if (parent) await inTransaction(async m => {
      await clubs.lockLocations(m, [parent.location_id]);
      await adjustments.expireAdjustmentsAtLocation(m, parent.location_id);
    });
  }
  const current = await adjustments.findAdjustment(manager, id);
  if (!current) throw new Error("Adjustment unavailable");
  const refunds = await adjustments.listAdjustmentRefunds(manager, id);
  const refundStatus = summarizeRefunds(refunds.map(r => r.status));
  const attempt = await adjustments.adjustmentAttempt(manager, id);
  revalidateCourtActivity("edit");
  return { status: current.status === "applied" ? "confirmed" as const
    : current.status === "pending" ? "pending_payment" as const : current.status === "cancelled" ? "cancelled" as const : "expired" as const,
    paymentStatus: refundStatus === "succeeded" ? "refunded" as const : refundStatus === "failed" ? "refund_failed" as const
      : refundStatus ? "refund_pending" as const : attempt?.status === "succeeded" ? "succeeded" as const
      : current.status === "pending" ? "pending" as const : current.status === "cancelled" ? "cancelled" as const : "expired" as const,
    paymentUncertain: false, cancellationRequested: current.status === "cancelled", totalAmountMinor: current.newTotal,
    currency: z.enum(locationCurrencies).parse(current.currency), cancellationPolicy: null };
}
export async function cancelAdjustmentIntent(attemptId: string) {
  const manager = (await getDataSource()).manager;
  const attempt = await payments.findCheckoutAttempt(manager, attemptId);
  if (!attempt?.adjustmentId) throw new Error("Adjustment unavailable");
  const parent = await bookings.discoverBookingLocation(manager, attempt.bookingId);
  if (!parent) throw new Error("Booking unavailable");
  const adjustmentId = attempt.adjustmentId;
  await inTransaction(async m => {
    await clubs.lockLocations(m, [parent.location_id]);
    await bookings.lockCheckoutBooking(m, attempt.bookingId);
    await payments.lockCheckoutAttempt(m, attemptId);
    const adjustment = await adjustments.findAdjustment(m, adjustmentId);
    if (!adjustment || adjustment.status === "applied") throw new Error("Modification already completed");
    await adjustments.updateAdjustment(m, adjustment.id, "cancelled");
    await adjustments.releaseAdjustmentHolds(m, adjustment.id);
  });
  revalidateCourtActivity("edit");
}
