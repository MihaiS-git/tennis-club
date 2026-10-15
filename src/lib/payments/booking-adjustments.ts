import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import type { BookingRescheduleResult } from "@/lib/bookings/reschedule";
import { processBookingRefund } from "./refunds";
import { summarizeRefunds } from "./domain";
import { onlinePaymentAdapter } from "./providers";
import { processOnlinePaymentEvent, settleOnlinePayment } from "./service";
import { startOnlineCheckout, readAdjustmentStatus } from "./checkout";

export { readAdjustmentStatus, cancelAdjustmentIntent } from "./checkout";

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
          amountMinor: evidence.amountMinor, currency: evidence.currency,
          ...(evidence.providerCaptureId ? { providerCaptureId: evidence.providerCaptureId } : {}) });
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
