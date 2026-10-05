"use server";

import { revalidatePath } from "next/cache";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { customerBookingInputSchema } from "@/lib/bookings/domain";
import { commitCustomerCheckout } from "@/lib/bookings/checkout";
import { logger } from "@/lib/logger";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { OnlineCheckout } from "@/lib/payments/domain";
import { abandonOnlineCheckout, readOnlineCheckout } from "@/lib/payments/checkout";

export type CommitBookingResult = ({ ok: true; totalAmountMinor: number; currency: LocationCurrency; cancellationPolicy: ConfirmedCancellationPolicy | null } &
  ({ status: "confirmed"; holdExpiresAt: null } | { status: "pending_payment"; holdExpiresAt: string; checkout: OnlineCheckout }))
  | { ok: false; reason: "price_changed"; totalAmountMinor: number; currency: LocationCurrency }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; availabilityChanged?: boolean };

export async function commitCustomerBookingAction(input: unknown): Promise<CommitBookingResult> {
  const parsed = customerBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the customer details.",
    fieldErrors: fieldValidationErrors(parsed.error) };
  let result;
  try { result = await commitCustomerCheckout(parsed.data); }
  catch {
    logger.error({ event: "bookings.action_failed" }, "Customer booking action failed");
    return { ok: false, message: "Unable to confirm the booking. Please try again." };
  }
  if (!result.ok) {
    if ("reason" in result) return result;
    if (result.availabilityChanged) revalidatePath("/book");
    return { ok: false, message: result.message, availabilityChanged: result.availabilityChanged };
  }
  revalidateCourtActivity("create");
  if (result.status === "pending_payment") {
    return { ok: true, status: result.status, holdExpiresAt: result.holdExpiresAt, checkout: result.checkout,
      totalAmountMinor: result.totalAmountMinor, currency: result.currency, cancellationPolicy: null };
  }
  return { ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: result.totalAmountMinor, currency: result.currency, cancellationPolicy: result.cancellationPolicy };
}

export async function readCheckoutStatusAction(input: unknown) {
  try { return { ok: true as const, ...await readOnlineCheckout(input) }; }
  catch { return { ok: false as const, message: "Unable to check payment. Please try again." }; }
}

export async function abandonCheckoutAction(input: unknown) {
  try {
    const result = await abandonOnlineCheckout(input);
    if (!result.released) return { ok: false as const,
      message: "Payment is processing or has already completed. Wait for booking confirmation." };
    revalidatePath("/book");
    return { ok: true as const };
  } catch {
    logger.error({ event: "payments.abandonment_failed" }, "Unable to abandon checkout");
    return { ok: false as const, message: "Unable to cancel payment. Please try again. Your hold will expire automatically." };
  }
}
