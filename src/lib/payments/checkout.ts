import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { readCreatedBookingCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import { paymentProviderSchema, type OnlineCheckout } from "./domain";
import { onlinePaymentAdapter } from "./providers";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { settleOnlinePayment } from "./service";

const attemptSchema = z.object({ id: z.uuid(), booking_id: z.uuid(), method: z.literal("online"),
  provider: paymentProviderSchema, amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]), expires_at: z.string() });
export const checkoutAccessSchema = z.strictObject({ attemptId: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// Validate the checkout capability before contacting the provider. Provider cancellation
// must succeed before releasing occupancy, so a concurrent card attempt cannot charge
// a court that we have already made available to another customer.
export async function abandonOnlineCheckout(input: unknown, writer = createBookingWriter()) {
  const access = checkoutAccessSchema.parse(input);
  const result = await writer.from("payment_attempts").select("*")
    .eq("id", access.attemptId).eq("checkout_token_hash", tokenHash(access.token)).single();
  if (result.error) throw new Error("Payment unavailable.");
  const attempt = attemptSchema.extend({ provider_payment_id: z.string().min(1) }).parse(result.data);
  if (attempt.status === "succeeded") return { released: false as const };
  const adapter = await onlinePaymentAdapter(attempt.provider);
  const cancelled = await adapter.cancelPayment({ id: attempt.id, providerPaymentId: attempt.provider_payment_id });
  if (cancelled !== "cancelled") return { released: false as const };
  // Reuse the existing booking-first transaction. A settled success cannot be downgraded.
  const status = await settleOnlinePayment({ attemptId: attempt.id, provider: attempt.provider,
    providerPaymentId: attempt.provider_payment_id, outcome: "cancelled" }, writer);
  if (status === "succeeded") return { released: false as const };
  if (status !== "cancelled" && status !== "expired" && status !== "failed")
    throw new Error("Unable to release the payment hold.");
  return { released: true as const };
}

// Called only with the attempt returned by the trusted booking creation operation.
export async function startOnlineCheckout(attemptId: string, writer = createBookingWriter()): Promise<OnlineCheckout> {
  const result = await writer.from("payment_attempts").select("*").eq("id", attemptId).single();
  if (result.error) throw new Error("Unable to read payment attempt.");
  const attempt = attemptSchema.parse(result.data);
  if (attempt.status !== "pending" || Date.parse(attempt.expires_at) <= Date.now()) throw new Error("Payment hold expired.");
  const adapter = await onlinePaymentAdapter(attempt.provider);
  const payment = await adapter.createPayment({ id: attempt.id, amountMinor: attempt.amount_minor, currency: attempt.currency });
  const token = randomBytes(32).toString("hex");
  const attached = await writer.rpc("attach_online_payment", { p_attempt_id: attempt.id, p_provider: attempt.provider,
    p_provider_payment_id: payment.providerPaymentId, p_token_hash: tokenHash(token) });
  if (attached.error || attached.data !== true) throw new Error("Unable to register payment.");
  if (Date.parse(attempt.expires_at) <= Date.now()) throw new Error("Payment hold expired.");
  return { attemptId: attempt.id, token, presentation: payment.presentation };
}

// Capability-bound polling works for guests too; no customer identity is accepted.
export async function readOnlineCheckout(input: unknown, writer = createBookingWriter()) {
  const access = checkoutAccessSchema.parse(input);
  const result = await writer.from("payment_attempts").select("*")
    .eq("id", access.attemptId).eq("checkout_token_hash", tokenHash(access.token)).single();
  if (result.error) throw new Error("Payment unavailable.");
  const attempt = attemptSchema.parse(result.data);
  const expiry = await writer.rpc("expire_payment_holds");
  if (expiry.error) throw new Error("Unable to check payment hold.");
  const booking = await writer.from("bookings").select("status").eq("id", attempt.booking_id).single();
  if (booking.error) throw new Error("Payment unavailable.");
  const status = z.enum(["pending_payment", "confirmed", "expired", "failed", "cancelled", "completed"]).parse(booking.data.status);
  // Also refresh the current calendar when a webhook already released this hold.
  if (expiry.data > 0 || status === "expired" || status === "failed") revalidatePath("/book");
  return { status, totalAmountMinor: attempt.amount_minor, currency: attempt.currency,
    cancellationPolicy: status === "confirmed" ? await readCreatedBookingCancellationPolicy(attempt.booking_id, writer) : null };
}
