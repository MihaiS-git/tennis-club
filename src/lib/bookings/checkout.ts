import "server-only";
import { customerBookingInputSchema } from "./domain";
import { createCustomerBooking } from "./service";
import { activeOnlinePaymentProvider } from "@/lib/payments/settings";
import { supportsOnlineCheckout } from "@/lib/payments/providers";
import { startOnlineCheckout } from "@/lib/payments/checkout";
import { paymentHoldDurationSeconds } from "@/lib/payments/domain";
import { logger } from "@/lib/logger";
import { deliverPendingBookingNotifications } from "@/lib/notifications/booking-delivery";

// Provider initialization starts only after the TypeORM creation transaction commits.
export async function commitCustomerCheckout(input: unknown) {
  const intent = customerBookingInputSchema.parse(input);
  if (intent.paymentMethod === "online" && !supportsOnlineCheckout(await activeOnlinePaymentProvider()))
    return { ok: false as const, message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." };
  const result = await createCustomerBooking(intent);
  if (!result.ok) return result;
  // Pay at club confirms at creation; its committed confirmation email goes now.
  if (result.status === "confirmed") { await deliverPendingBookingNotifications(); return result; }
  try {
    const checkout = await startOnlineCheckout(result.paymentAttemptId);
    return { ...result, checkout };
  } catch {
    logger.error({ event: "payments.checkout_start_failed", attemptId: result.paymentAttemptId }, "Unable to start online payment");
    return { ok: false as const, availabilityChanged: true,
      message: `Unable to start payment. No booking is confirmed. The temporary hold will expire within ${paymentHoldDurationSeconds / 60} minutes.` };
  }
}
