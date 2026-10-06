import { verifyStripeEvent } from "@/lib/payments/providers/stripe/adapter";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
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
    await processOnlinePaymentEvent(event);
    revalidateCourtActivity("create");
    return Response.json({ received: true });
  } catch {
    return new Response("Payment processing unavailable", { status: 503 });
  }
}
