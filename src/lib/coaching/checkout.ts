import "server-only";

import { createCoachingBooking } from "./booking";
import { startOnlineCheckout } from "@/lib/payments/checkout";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import { logger } from "@/lib/logger";

// The /book coaching Server Action delegates here. Creation validates the
// verified customer and selected provider; Stripe starts only after commit.
export async function commitCoachingCheckout(input: unknown, reader?: Parameters<typeof createCoachingBooking>[1]) {
  const result = await createCoachingBooking(input, reader);
  if (!result.ok) return result;
  try {
    const checkout = await startOnlineCheckout(result.paymentAttemptId);
    return { ...result, checkout };
  } catch {
    logger.error({ event: "payments.checkout_start_failed", attemptId: result.paymentAttemptId }, "Unable to start online payment");
    return { ok: false as const, availabilityChanged: true,
      message: `Unable to start payment. No booking is confirmed. The temporary hold will expire within ${paymentHoldDurationSeconds / 60} minutes.` };
  }
}
