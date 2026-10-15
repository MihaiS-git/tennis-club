import "server-only";
import { hasBookingAdjustments } from "@/lib/db/repositories/booking-adjustments.repository";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import type { EntityManager } from "typeorm";
import { buildBookingRevision } from "@/lib/bookings/revision";
import { advanceRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockCheckoutBooking, findCheckoutBookingStatus } from "@/lib/db/repositories/bookings.repository";
import { findCheckoutAttempt, lockCheckoutAttempt, attachCheckoutPayment } from "@/lib/db/repositories/payments.repository";
import { expirePaymentHolds, expireAdjustmentsAtLocation } from "./hold-expiry";
import { readCreatedBookingCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { paymentProviderSchema, summarizeRefunds, type OnlineCheckout } from "./domain";
import { onlinePaymentAdapter, supportsOnlineCheckout } from "./providers";
import { logger } from "@/lib/logger";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { processOnlinePaymentEvent, settleOnlinePayment } from "./service";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { allocateBookingRefund } from "./financials";
import { processBookingRefund } from "./refunds";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";

const attemptSchema = z.object({ id: z.uuid(), bookingId: z.uuid(), method: z.literal("online"),
  provider: paymentProviderSchema, amountMinor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]), expiresAt: z.date(), adjustmentId: z.uuid().nullable().optional() });
const checkoutAccessSchema = z.strictObject({ attemptId: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// Presentation of an existing checkout capability only. Owner recovery may
// initialize payment or rotate tokens; opening this link must do neither.
export async function readAdjustmentPaymentLink(input: unknown) {
  const parsed = z.object({ adjustmentId: z.uuid(), token: checkoutAccessSchema.shape.token }).safeParse(input);
  const unavailable = { kind: "unavailable" } as const;
  if (!parsed.success) return unavailable;
  try {
    const manager = (await getDataSource()).manager;
    const adjustment = await adjustments.findAdjustment(manager, parsed.data.adjustmentId);
    const attempt = await adjustments.adjustmentAttempt(manager, parsed.data.adjustmentId);
    if (!adjustment || adjustment.id !== parsed.data.adjustmentId || !attempt?.providerPaymentId
      || attempt.adjustmentId !== adjustment.id || attempt.bookingId !== adjustment.bookingId
      || attempt.checkoutTokenHash !== tokenHash(parsed.data.token)
      || attempt.method !== "online" || !attempt.provider || !supportsOnlineCheckout(attempt.provider)) return unavailable;
    const currency = z.enum(locationCurrencies).parse(adjustment.currency);
    const presentation = await (await onlinePaymentAdapter(attempt.provider)).resumePayment({
      id: attempt.id, providerPaymentId: attempt.providerPaymentId,
    });
    // Terminal states and hold expiry remain handled by the existing capability
    // polling/OnlinePayment flow. Presentation does not settle or expire anything.
    return { kind: "checkout" as const, originalTotal: adjustment.originalTotal, newTotal: adjustment.newTotal, currency,
      checkout: { attemptId: attempt.id, token: parsed.data.token, presentation },
      holdExpiresAt: adjustment.expiresAt.toISOString() };
  } catch (error: unknown) {
    logger.error({ event: "payments.adjustment_link_read_failed", code: normalizeDatabaseError(error).sqlState },
      "Unable to present adjustment payment link");
    return unavailable;
  }
}

class CheckoutParentChanged extends Error {}

// Accept cancellation and release occupancy before contacting Stripe. The
// attempt remains uncertain until provider evidence arrives; late capture is
// compensated by the existing settlement service without reclaiming occupancy.
async function requestCheckoutCancellation(access: z.infer<typeof checkoutAccessSchema>, retry = 0): Promise<void> {
  try {
    await inTransaction(async manager => {
      const parent = await payments.discoverSettlementParent(manager, access.attemptId);
      if (!parent) throw new Error("Payment unavailable.");
      await lockLocations(manager, [parent.location_id]);
      const booking = await bookings.findBookingForUpdate(manager, parent.booking_id);
      const reservation = booking && await reservations.findReservationForUpdate(manager, booking.reservation_id);
      const attempt = await lockCheckoutAttempt(manager, access.attemptId);
      const resource = reservation && await reservations.findReservationResourceFacts(manager, reservation.court_id);
      if (!booking || !reservation || !attempt || attempt.bookingId !== booking.id
        || attempt.checkoutTokenHash !== tokenHash(access.token) || attempt.method !== "online")
        throw new Error("Payment unavailable.");
      if (booking.reservation_id !== parent.reservation_id || resource?.location_id !== parent.location_id)
        throw new CheckoutParentChanged();
      // Initial checkout capability cannot undo later management operations or
      // override an explicit owner/Admin cancellation/refund decision.
      if (reservation.status === "cancelled" || booking.status === "confirmed" && (booking.revision.revisionNumber > 2 || await hasBookingAdjustments(manager,booking.id)))
        throw new Error("This checkout is now managed through booking management.");
      // A checkout capability is not an indefinite guest booking-management
      // permission. Only a completion racing the original hold may be undone.
      if (booking.status === "confirmed" && (!attempt.expiresAt
        || new Date(await reservations.readReservationClockTime(manager)).getTime() >= attempt.expiresAt.getTime()))
        throw new Error("This checkout has already confirmed. Use booking management to cancel it.");
      let contextRevisionId = booking.current_revision_id;
      if (booking.status !== "cancelled") {
        const revision = buildBookingRevision(booking.revision, { id: randomUUID(), bookingId: booking.id,
          kind: "cancelled", bookingState: "cancelled", operationKey: "cancellation", intentHash: "checkout_abandoned",
          actorUserId: null, actorScope: "guest", recordedAt: new Date(await reservations.readReservationClockTime(manager)),
          adjustmentId: null, cancellationCause: "checkout_abandoned" }, booking.revision);
        await advanceRevision(manager, { revision, previousId: booking.current_revision_id, status: "cancelled" });
        contextRevisionId = revision.id;
        await reservations.updateSettlementReservationStatus(manager, reservation.id, "released");
      }
      if (attempt.status === "succeeded" && attempt.provider === "stripe" && attempt.providerPaymentId) {
        if (reservation.status === "active") await reservations.updateSettlementReservationStatus(manager, reservation.id, "released");
        if (!await payments.findAndLockRefundByBooking(manager, booking.id, attempt.id))
          await allocateBookingRefund(manager, { bookingId: booking.id, actorId: null,
            operationKey: "cancellation", amount: attempt.amountMinor, onlyAttemptId: attempt.id,
            reason: "booking_cancellation", contextRevisionId });
      }
    });
  } catch (error) {
    if (error instanceof CheckoutParentChanged && retry < 2) return requestCheckoutCancellation(access, retry + 1);
    throw error;
  }
}

// Provider retrieval is authoritative evidence, not a browser confirmation.
// A stable observation receipt makes polling safe alongside delayed webhooks.
async function observeCheckoutPayment(attempt: z.infer<typeof attemptSchema> & { providerPaymentId: string }) {
  const result = await (await onlinePaymentAdapter(attempt.provider)).readPayment({
    id: attempt.id, providerPaymentId: attempt.providerPaymentId,
  });
  if (result.status === "succeeded" || result.status === "cancelled") {
    await processOnlinePaymentEvent({ attemptId: attempt.id, provider: attempt.provider,
      providerPaymentId: attempt.providerPaymentId, eventId: `checkout-observation-${attempt.id}-${result.status}`,
      outcome: result.status, amountMinor: result.amountMinor, currency: result.currency,
      ...(result.providerCaptureId ? { providerCaptureId: result.providerCaptureId } : {}) });
    revalidateCourtActivity("create");
  }
  return result.status;
}

// Validate the capability before contacting the provider, including retries.
export async function abandonOnlineCheckout(input: unknown) {
  const access = checkoutAccessSchema.parse(input);
  const row = await findCheckoutAttempt((await getDataSource()).manager, access.attemptId, tokenHash(access.token));
  const attempt = attemptSchema.extend({ providerPaymentId: z.string().min(1) }).parse(row);
  if (attempt.adjustmentId) await cancelAdjustmentIntent(attempt.id);
  else await requestCheckoutCancellation(access);
  revalidateCourtActivity("create");
  const adapter = await onlinePaymentAdapter(attempt.provider);
  const cancelled = attempt.status === "succeeded" ? "succeeded"
    : await adapter.cancelPayment({ id: attempt.id, providerPaymentId: attempt.providerPaymentId });
  if (cancelled === "cancelled") {
    await settleOnlinePayment({ attemptId: attempt.id, provider: attempt.provider,
      providerPaymentId: attempt.providerPaymentId, outcome: "cancelled" });
  } else if (cancelled === "succeeded" && attempt.status !== "succeeded") await observeCheckoutPayment(attempt);
  const refund = await payments.findCheckoutRefund((await getDataSource()).manager, attempt.id);
  if (refund && refund.status !== "succeeded" && refund.status !== "failed") await processBookingRefund(refund.id);
  const result = await readOnlineCheckout(input);
  return { released: ["cancelled", "refunded", "refund_pending", "refund_failed"].includes(result.paymentStatus),
    paymentStatus: result.paymentStatus };
}

// Called only with the attempt returned by trusted booking creation.
export async function startOnlineCheckout(attemptId: string): Promise<OnlineCheckout> {
  const attempt = attemptSchema.parse(await findCheckoutAttempt((await getDataSource()).manager, attemptId));
  if (attempt.status !== "pending" || attempt.expiresAt.getTime() <= Date.now()) throw new Error("Payment hold expired.");
  const adapter = await onlinePaymentAdapter(attempt.provider);
  // No database transaction remains open across this network call.
  const payment = await adapter.createPayment({ id: attempt.id, amountMinor: attempt.amountMinor, currency: attempt.currency });
  const providerPaymentId = z.string().min(1).max(255).parse(payment.providerPaymentId);
  const token = randomBytes(32).toString("hex");
  const attached = await inTransaction(async (manager) => {
    if (!await lockCheckoutBooking(manager, attempt.bookingId)) return false;
    const current = await lockCheckoutAttempt(manager, attempt.id);
    if (!current || current.bookingId !== attempt.bookingId || current.method !== "online"
      || current.provider !== attempt.provider || current.checkoutTokenHash !== null
      || (current.providerPaymentId !== null && current.providerPaymentId !== providerPaymentId)) return false;
    // Deliberately attach after expiry too: retain evidence without reopening occupancy.
    return attachCheckoutPayment(manager, { attemptId: attempt.id, bookingId: attempt.bookingId,
      provider: attempt.provider, providerPaymentId, tokenHash: tokenHash(token) });
  });
  if (!attached) throw new Error("Unable to register payment.");
  const current = attemptSchema.parse(await findCheckoutAttempt((await getDataSource()).manager, attempt.id));
  if (current.status !== "pending" || current.expiresAt.getTime() <= Date.now()) {
    try { await adapter.cancelPayment({ id: attempt.id, providerPaymentId }); }
    catch { /* Evidence is attached; expiry and provider reconciliation remain authoritative. */ }
    throw new Error("Payment hold expired.");
  }
  return { attemptId: attempt.id, token, presentation: payment.presentation };
}

// Capability-bound polling works for guests too; no customer identity is accepted.
export async function readOnlineCheckout(input: unknown) {
  const access = checkoutAccessSchema.parse(input);
  const manager = (await getDataSource()).manager;
  const row = await findCheckoutAttempt(manager, access.attemptId, tokenHash(access.token));
  const attempt = attemptSchema.extend({ providerPaymentId: z.string().nullable() }).parse(row);
  let providerStatus: "pending" | "processing" | "succeeded" | "cancelled" | "unknown" = "unknown";
  if (attempt.providerPaymentId && attempt.status !== "cancelled" && attempt.status !== "succeeded") {
    try { providerStatus = await observeCheckoutPayment({ ...attempt, providerPaymentId: attempt.providerPaymentId }); }
    catch { /* Keep DB evidence and financial uncertainty; webhook/Admin reconciliation remains available. */ }
  }
  if (attempt.adjustmentId) {
    const result = await readAdjustmentStatus(manager, attempt.adjustmentId);
    return { ...result, paymentUncertain: !["succeeded", "cancelled"].includes(attempt.status) && (providerStatus === "unknown" || providerStatus === "processing"),
      paymentStatus: result.status === "pending_payment" && providerStatus === "unknown" ? "unknown" as const
        : result.status === "pending_payment" && providerStatus === "processing" ? "processing" as const : result.paymentStatus };
  }
  const expiry = await expirePaymentHolds();
  const booking = await findCheckoutBookingStatus(manager, attempt.bookingId);
  let current = attemptSchema.parse(await findCheckoutAttempt(manager, access.attemptId, tokenHash(access.token)));
  if (!booking) throw new Error("Payment unavailable.");
  const status = z.enum(["pending_payment", "confirmed", "expired", "failed", "cancelled", "completed"]).parse(booking.status);
  if (attempt.providerPaymentId && !["succeeded", "cancelled", "failed"].includes(current.status)
    && (status === "cancelled" || status === "expired")) {
    try {
      const cancelled = await (await onlinePaymentAdapter(attempt.provider)).cancelPayment({ id: attempt.id,
        providerPaymentId: attempt.providerPaymentId });
      providerStatus = cancelled;
      if (cancelled === "cancelled") await settleOnlinePayment({ attemptId: attempt.id, provider: attempt.provider,
        providerPaymentId: attempt.providerPaymentId, outcome: "cancelled" });
      else if (cancelled === "succeeded") await observeCheckoutPayment({ ...attempt, providerPaymentId: attempt.providerPaymentId });
      current = attemptSchema.parse(await findCheckoutAttempt(manager, access.attemptId, tokenHash(access.token)));
    } catch { providerStatus = "unknown"; }
  }
  const { captures } = await payments.findRefundCaptureEvidence(manager, attempt.id);
  const refund = await payments.findCheckoutRefund(manager, attempt.id);
  const captured = captures.some(receipt => receipt.provider === attempt.provider
    && receipt.providerPaymentId === attempt.providerPaymentId
    && receipt.amountMinor === attempt.amountMinor && receipt.currency === attempt.currency);
  const paymentStatus = refund ? refund.status === "succeeded" ? "refunded" as const
    : refund.status === "failed" ? "refund_failed" as const : "refund_pending" as const
    : captured && status !== "confirmed" ? "refund_pending" as const
    : current.status === "succeeded" ? "succeeded" as const
    : current.status === "cancelled" || providerStatus === "cancelled" ? "cancelled" as const
    : current.status === "failed" ? "failed" as const
    : current.status === "expired" ? "expired" as const
    : providerStatus === "unknown" ? "unknown" as const
    : status === "cancelled" || providerStatus === "processing" ? "processing" as const : "pending" as const;
  if (expiry > 0 || status !== "pending_payment") revalidatePath("/book");
  return { status, paymentStatus, paymentUncertain: !captured && current.status !== "cancelled"
    && (providerStatus === "unknown" || providerStatus === "processing"),
    cancellationRequested: status === "cancelled", totalAmountMinor: attempt.amountMinor, currency: attempt.currency,
    cancellationPolicy: status === "confirmed" ? await readCreatedBookingCancellationPolicy(attempt.bookingId) : null };
}

export async function readAdjustmentStatus(manager: EntityManager, id: string) {
  const adjustment = await adjustments.findAdjustment(manager, id);
  if (!adjustment) throw new Error("Adjustment unavailable");
  // Only the location mutex can release target holds. Polling uses that same lock.
  if (["pending","cancelled"].includes(adjustment.status) && adjustment.expiresAt.getTime() <= Date.now()) {
    const parent = await bookings.discoverBookingLocation(manager, adjustment.bookingId);
    if (parent) await inTransaction(async m => {
      await lockLocations(m, [parent.location_id]);
      await expireAdjustmentsAtLocation(m, parent.location_id);
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
    await lockLocations(m, [parent.location_id]);
    await bookings.lockCheckoutBooking(m, attempt.bookingId);
    await payments.lockCheckoutAttempt(m, attemptId);
    const adjustment = await adjustments.findAdjustment(m, adjustmentId);
    if (!adjustment || adjustment.status === "applied") throw new Error("Modification already completed");
    await adjustments.updateAdjustment(m, adjustment.id, "cancelled");
    await adjustments.releaseAdjustmentHolds(m, adjustment.id);
  });
  revalidateCourtActivity("edit");
}
