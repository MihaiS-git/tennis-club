import "server-only";
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
import { settleOnlinePayment } from "./service";

const attemptSchema = z.object({ id: z.uuid(), bookingId: z.uuid(), method: z.literal("online"),
  provider: paymentProviderSchema, amountMinor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]), expiresAt: z.date() });
const checkoutAccessSchema = z.strictObject({ attemptId: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// Validate the capability before contacting the provider.
export async function abandonOnlineCheckout(input: unknown) {
  const access = checkoutAccessSchema.parse(input);
  const row = await findCheckoutAttempt((await getDataSource()).manager, access.attemptId, tokenHash(access.token));
  const attempt = attemptSchema.extend({ providerPaymentId: z.string().min(1) }).parse(row);
  if (attempt.status === "succeeded") return { released: false as const };
  const adapter = await onlinePaymentAdapter(attempt.provider);
  const cancelled = await adapter.cancelPayment({ id: attempt.id, providerPaymentId: attempt.providerPaymentId });
  if (cancelled !== "cancelled") return { released: false as const };
  // Never release occupancy before provider cancellation; a settled success cannot be downgraded.
  const status = await settleOnlinePayment({ attemptId: attempt.id, provider: attempt.provider,
    providerPaymentId: attempt.providerPaymentId, outcome: "cancelled" });
  if (status === "succeeded") return { released: false as const };
  if (status !== "cancelled" && status !== "expired" && status !== "failed")
    throw new Error("Unable to release the payment hold.");
  return { released: true as const };
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
  if (attempt.expiresAt.getTime() <= Date.now()) throw new Error("Payment hold expired.");
  return { attemptId: attempt.id, token, presentation: payment.presentation };
}

// Capability-bound polling works for guests too; no customer identity is accepted.
export async function readOnlineCheckout(input: unknown) {
  const access = checkoutAccessSchema.parse(input);
  const manager = (await getDataSource()).manager;
  const attempt = attemptSchema.parse(await findCheckoutAttempt(manager, access.attemptId, tokenHash(access.token)));
  const expiry = await expirePaymentHolds();
  const booking = await findCheckoutBookingStatus(manager, attempt.bookingId);
  if (!booking) throw new Error("Payment unavailable.");
  const status = z.enum(["pending_payment", "confirmed", "expired", "failed", "cancelled", "completed"]).parse(booking.status);
  if (expiry > 0 || status === "expired" || status === "failed") revalidatePath("/book");
  return { status, totalAmountMinor: attempt.amountMinor, currency: attempt.currency,
    cancellationPolicy: status === "confirmed" ? await readCreatedBookingCancellationPolicy(attempt.bookingId) : null };
}
