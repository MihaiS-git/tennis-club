import "server-only";
import { startOnlineCheckout } from "./checkout";
import { paymentHoldDurationSeconds } from "./domain";
import { logger } from "@/lib/logger";

// Call only after the creation transaction has committed the pending attempt and
// its temporary hold. Failure leaves both intact; hold expiry stays authoritative.
export async function startCommittedCheckout<T extends { paymentAttemptId: string }>(result: T) {
  try {
    const checkout = await startOnlineCheckout(result.paymentAttemptId);
    return { ...result, checkout };
  } catch {
    logger.error({ event: "payments.checkout_start_failed", attemptId: result.paymentAttemptId }, "Unable to start online payment");
    return { ok: false as const, availabilityChanged: true,
      message: `Unable to start payment. No booking is confirmed. The temporary hold will expire within ${paymentHoldDurationSeconds / 60} minutes.` };
  }
}
