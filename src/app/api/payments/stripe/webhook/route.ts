import { verifyStripeEvent } from "@/lib/payments/providers/stripe/adapter";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { processBookingRefund } from "@/lib/payments/refunds";
import { extendLiveAdjustmentHold } from "@/lib/payments/hold-expiry";
import { resolveAuthorizedCheckoutPayment, resolveFailedCheckoutPayment } from "@/lib/payments/checkout";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Invalid signature", { status: 400 });
  let event;
  try {
    event = verifyStripeEvent(await request.text(), signature);
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }
  if (!event) return new Response(null, { status: 204 });
  try {
    // Processing never settles; it only keeps a modification's target blocked.
    if (event.outcome === "processing") {
      await extendLiveAdjustmentHold(event.attemptId, event.providerPaymentId);
      return Response.json({ received: true });
    }
    // An authorization never settles by itself: Stripe is re-read and the server
    // captures only inside the checkout deadline, otherwise cancels it.
    if (event.outcome === "authorized") {
      await resolveAuthorizedCheckoutPayment(event);
      return Response.json({ received: true });
    }
    // The refund is re-read from Stripe and committed through the shared refund
    // service: it never creates a refund for an unconfirmed earlier request.
    if (event.outcome === "refund_changed") {
      await processBookingRefund(event.refundId, { strict: true, providerChanged: true });
      revalidateCourtActivity("cancel");
      return Response.json({ received: true });
    }
    await processOnlinePaymentEvent(event, { strict: true });
    if (event.outcome === "retryable_failed") await resolveFailedCheckoutPayment(event);
    revalidateCourtActivity("create");
    return Response.json({ received: true });
  } catch {
    // Never acknowledge unfinished financial work: Stripe retries non-2xx
    // deliveries, and settlement and refund commits are idempotent.
    return new Response("Payment processing unavailable", { status: 503 });
  }
}
