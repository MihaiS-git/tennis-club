import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import type { BookingRescheduleResult } from "@/lib/bookings/reschedule";
import { logger } from "@/lib/logger";
import { processBookingRefund } from "./refunds";
import { summarizeRefunds, type PaymentProvider } from "./domain";
import { onlinePaymentAdapter } from "./providers";
import { processOnlinePaymentEvent, settleOnlinePayment } from "./service";
import { startOnlineCheckout } from "./checkout";
import { extendLiveAdjustmentHold } from "./hold-expiry";

export { readAdjustmentStatus } from "./checkout";

// Presents checkout only for a modification created by this request (or its
// exact replay). A dismissed modification's capability is revoked and never resumed.
async function adjustmentPresentation(id: string) {
  const manager = (await getDataSource()).manager;
  const adjustment = await adjustments.findAdjustment(manager, id);
  const attempt = await adjustments.adjustmentAttempt(manager, id);
  if (!adjustment || !attempt) throw new Error("Payment adjustment unavailable");
  if (adjustment.status !== "pending" || attempt.status !== "pending" || adjustment.expiresAt.getTime() <= Date.now()) return null;
  if (attempt.providerPaymentId && attempt.checkoutTokenHash === null) return null;
  let checkout;
  if (!attempt.providerPaymentId) {
    try { checkout = await startOnlineCheckout(attempt.id); }
    catch {
      // A concurrent initializer may already have attached this same intent.
      const latest = await adjustments.adjustmentAttempt(manager, id);
      if (!latest?.providerPaymentId || latest.checkoutTokenHash === null) throw new Error("Payment initialization failed");
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
      if (!locked || locked.providerPaymentId !== current.providerPaymentId || locked.adjustmentId !== id
        || locked.status !== "pending" || locked.checkoutTokenHash === null) throw new Error("Checkout reference changed");
      await payments.reissueCheckoutCapability(m,current.id,createHash("sha256").update(token).digest("hex"));
    });
    checkout = { attemptId: current.id, token, presentation };
  }
  return { totalAmountMinor: adjustment.newTotal, checkout, holdExpiresAt: adjustment.expiresAt.toISOString() };
}

type DismissedAttempt = { id: string; provider: PaymentProvider; providerPaymentId: string };

// Provider evidence decides a dismissed payment: anything still awaiting the
// customer is cancelled; a processing payment stays blocked for the webhook.
async function resolveDismissedPayment(attempt: DismissedAttempt) {
  const adapter = await onlinePaymentAdapter(attempt.provider);
  const outcome = await adapter.dismissPayment(attempt);
  if (outcome === "cancelled") {
    await settleOnlinePayment({ attemptId: attempt.id, provider: attempt.provider, providerPaymentId: attempt.providerPaymentId, outcome });
  } else if (outcome === "succeeded") {
    const evidence = await adapter.readPayment(attempt);
    if (evidence.status !== "succeeded") throw new Error("Payment evidence changed");
    await processOnlinePaymentEvent({ attemptId: attempt.id, provider: attempt.provider, providerPaymentId: attempt.providerPaymentId,
      eventId: `checkout-observation-${attempt.id}-succeeded`, outcome: "succeeded",
      amountMinor: evidence.amountMinor, currency: evidence.currency,
      ...(evidence.providerCaptureId ? { providerCaptureId: evidence.providerCaptureId } : {}) });
  } else await extendLiveAdjustmentHold(attempt.id, attempt.providerPaymentId);
  return outcome;
}

// X on the modification dialog. The capability is revoked first, so the
// dismissed checkout can never continue or be resumed.
export async function dismissAdjustment(adjustmentId: string) {
  const manager = (await getDataSource()).manager;
  const adjustment = await adjustments.findAdjustment(manager, adjustmentId);
  if (!adjustment) throw new Error("Adjustment unavailable");
  const parent = await bookings.discoverBookingLocation(manager, adjustment.bookingId);
  if (!parent) throw new Error("Booking unavailable");
  const attempt = await inTransaction(async m => {
    await lockLocations(m, [parent.location_id]);
    await bookings.lockCheckoutBooking(m, adjustment.bookingId);
    const current = await adjustments.adjustmentAttempt(m, adjustmentId);
    const locked = current && await payments.lockCheckoutAttempt(m, current.id);
    if (!locked || locked.status !== "pending" || !locked.provider) return null;
    await payments.revokeCheckoutCapability(m, locked.id);
    if (locked.providerPaymentId) return { id: locked.id, provider: locked.provider, providerPaymentId: locked.providerPaymentId };
    // No payment was ever registered: discard and release immediately.
    const status = (await adjustments.findAdjustment(m, adjustmentId))?.status;
    if (status === "pending") await adjustments.updateAdjustment(m, adjustmentId, "cancelled");
    await adjustments.releaseAdjustmentHolds(m, adjustmentId);
    await payments.cancelUnregisteredAttempt(m, locked.id);
    return null;
  });
  if (!attempt) return;
  try { await resolveDismissedPayment(attempt); }
  catch {
    // The lease still ends at the cutoff; a late success is refunded.
    logger.error({ event: "payments.adjustment_dismissal_unresolved", adjustmentId }, "Unable to resolve dismissed modification payment");
  }
}

export async function finishBookingAdjustment(result: BookingRescheduleResult & { supersededAttempts?: DismissedAttempt[] }): Promise<BookingRescheduleResult> {
  const { supersededAttempts = [], ...outcome } = result;
  for (const attempt of supersededAttempts) {
    try { await resolveDismissedPayment(attempt); }
    catch { logger.error({ event: "payments.adjustment_superseded_unresolved", attemptId: attempt.id }, "Unable to resolve superseded modification payment"); }
  }
  if (!outcome.ok || !outcome.adjustmentId) return outcome;
  const recorded = await adjustments.listAdjustmentRefunds((await getDataSource()).manager,outcome.adjustmentId);
  const refundIds = outcome.refundIds ?? recorded.map(r=>r.id);
  const statuses = await Promise.all(refundIds.map(id => processBookingRefund(id)));
  if (refundIds.length) {
    // A reduction waits for verified refunds; Stripe usually confirms at once and
    // the change is then already applied. Otherwise recovery finishes it later.
    const current = await adjustments.findAdjustment((await getDataSource()).manager, outcome.adjustmentId);
    return { ...outcome, refundIds, refundStatus: summarizeRefunds(statuses), adjustmentStatus: current?.status ?? outcome.adjustmentStatus };
  }
  if (outcome.adjustmentStatus !== "pending") return outcome;
  try {
    const presentation = await adjustmentPresentation(outcome.adjustmentId);
    if (presentation) return { ...outcome, ...presentation };
    const current = await adjustments.findAdjustment((await getDataSource()).manager, outcome.adjustmentId);
    return { ...outcome, adjustmentStatus: current?.status ?? outcome.adjustmentStatus };
  }
  catch { return outcome; } // Never report a new booking as applied; the lease still ends at the cutoff.
}
