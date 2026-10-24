"use server";

import { coachingBookingInputSchema } from "@/lib/coaching/booking";
import { commitCoachingCheckout } from "@/lib/coaching/checkout";
import { revalidatePath } from "next/cache";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { customerBookingInputSchema } from "@/lib/bookings/domain";
import { commitCustomerCheckout } from "@/lib/bookings/checkout";
import { logger } from "@/lib/logger";
import type { ConfirmedCancellationPolicy } from "@/lib/bookings/confirmation-policy";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { OnlineCheckout } from "@/lib/payments/domain";
import { abandonOnlineCheckout } from "@/lib/payments/checkout";

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

export async function abandonCheckoutAction(input: unknown) {
  try {
    const result = await abandonOnlineCheckout(input);
    if (!result.released) return { ok: false as const,
      message: "Cancellation requested. The payment outcome is still uncertain. You may close this window; do not pay again yet." };
    revalidatePath("/book");
    return { ok: true as const, paymentStatus: result.paymentStatus };
  } catch {
    logger.error({ event: "payments.abandonment_failed" }, "Unable to abandon checkout");
    return { ok: false as const, message: "Unable to confirm payment cancellation. You may close this window; do not pay again until its outcome is established." };
  }
}


export async function commitCoachingBookingAction(input: unknown): Promise<CommitBookingResult> {
  const parsed = coachingBookingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the lesson and customer details.", fieldErrors: fieldValidationErrors(parsed.error) };
  try {
    const result = await commitCoachingCheckout(parsed.data);
    if (!result.ok) {
      if ("reason" in result && result.reason === "price_changed") return result;
      const availabilityChanged = "availabilityChanged" in result && result.availabilityChanged
        || "reason" in result && ["not-offered", "invalid-participants", "invalid-duration", "unpriced", "coach-unavailable", "coach-booked",
          "court-unavailable", "location-unavailable", "past", "changed"].includes(result.reason);
      if (availabilityChanged) revalidatePath("/book");
      return { ok: false, message: result.message, availabilityChanged };
    }
    revalidateCourtActivity("create");
    return { ok: true, status: "pending_payment", holdExpiresAt: result.holdExpiresAt, checkout: result.checkout,
      totalAmountMinor: result.totalAmountMinor, currency: result.currency, cancellationPolicy: null };
  } catch {
    logger.error({ event: "coaching.action_failed" }, "Coaching checkout action failed");
    return { ok: false, message: "Unable to start this lesson booking. Please try again." };
  }
}
