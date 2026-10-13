import "server-only";
import { hasBookingAdjustments } from "@/lib/db/repositories/booking-adjustments.repository";
import { readAdjustmentStatus, cancelAdjustmentIntent } from "./booking-adjustments";
import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockCheckoutBooking, findCheckoutBookingStatus } from "@/lib/db/repositories/bookings.repository";
import { findCheckoutAttempt, lockCheckoutAttempt, attachCheckoutPayment } from "@/lib/db/repositories/payments.repository";
import { expirePaymentHolds } from "./hold-expiry";
import { readCreatedBookingCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { paymentProviderSchema, type OnlineCheckout } from "./domain";
import { onlinePaymentAdapter } from "./providers";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { processOnlinePaymentEvent, settleOnlinePayment } from "./service";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { processBookingRefund } from "./refunds";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";

const attemptSchema = z.object({ id: z.uuid(), bookingId: z.uuid(), method: z.literal("online"),
  provider: paymentProviderSchema, amountMinor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]), expiresAt: z.date(), adjustmentId: z.uuid().nullable().optional() });
const checkoutAccessSchema = z.strictObject({ attemptId: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

class CheckoutParentChanged extends Error {}

// Record customer intent before contacting Stripe. Keep uncertain occupancy
// until provider cancellation, captured-payment refund preparation, or hold expiry.
async function requestCheckoutCancellation(access: z.infer<typeof checkoutAccessSchema>, retry = 0): Promise<void> {
  try {
    await inTransaction(async manager => {
      const parent = await payments.discoverSettlementParent(manager, access.attemptId);
      if (!parent) throw new Error("Payment unavailable.");
      await lockLocations(manager, [parent.location_id]);
      const booking = await bookings.lockSettlementBooking(manager, parent.booking_id);
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
      if (reservation.status === "cancelled" || booking.status === "confirmed" && await hasBookingAdjustments(manager,booking.id))
        throw new Error("This checkout is now managed through booking management.");
      // A checkout capability is not an indefinite guest booking-management
      // permission. Only a completion racing the original hold may be undone.
      if (booking.status === "confirmed" && (!attempt.expiresAt
        || new Date(await reservations.readReservationClockTime(manager)).getTime() >= attempt.expiresAt.getTime()))
        throw new Error("This checkout has already confirmed. Use booking management to cancel it.");
      if (booking.status !== "cancelled")
        await bookings.updateSettlementBookingStatus(manager, booking.id, "cancelled");
      if (attempt.status === "succeeded" && attempt.provider === "stripe" && attempt.providerPaymentId) {
        if (reservation.status === "active") await reservations.updateSettlementReservationStatus(manager, reservation.id, "released");
        if (!await payments.findAndLockRefundByBooking(manager, booking.id))
          await payments.insertBookingRefundRequest(manager, booking.id, null, {
            id: attempt.id, provider: "stripe", provider_payment_id: attempt.providerPaymentId,
            amount_minor: attempt.amountMinor, currency: attempt.currency,
          });
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
      outcome: result.status, amountMinor: result.amountMinor, currency: result.currency });
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
  const { payment, events } = await payments.findRefundCaptureEvidence(manager, attempt.id);
  const refund = await payments.findCheckoutRefund(manager, attempt.id);
  const captured = payment?.status === "succeeded" || events.some(e => e.outcome === "succeeded"
    && e.provider_payment_id === attempt.providerPaymentId && e.amount_minor === attempt.amountMinor && e.currency === attempt.currency);
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
