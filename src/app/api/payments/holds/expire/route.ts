import { revalidatePath } from "next/cache";
import { authorizedBearer } from "@/lib/notifications/auth";
import { cleanupScheduledCheckouts } from "@/lib/payments/scheduled-checkout-cleanup";
import { logger } from "@/lib/logger";

export const maxDuration = 25;

// Supabase Cron sweep for abandoned checkout holds. Availability already ignores
// expired holds by database time; settle local aggregates and reconcile a bounded
// sample of unresolved Stripe checkouts through the existing services.
export async function POST(request: Request) {
  if (!authorizedBearer(request.headers.get("authorization"), process.env.CHECKOUT_EXPIRY_CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  try {
    const expired = await cleanupScheduledCheckouts();
    if (expired > 0) revalidatePath("/book");
    return Response.json({ expired });
  } catch (error) {
    logger.error({ event: "payments.hold_expiry_failed", error }, "Checkout hold expiry invocation failed");
    return Response.json({ error: "Expiry unavailable" }, { status: 503 });
  }
}
