import { authorizedBearer } from "@/lib/notifications/auth";
import { processPendingEmailDeliveries } from "@/lib/notifications/delivery";
import { logger } from "@/lib/logger";

export const maxDuration = 25;

export async function POST(request: Request) {
  if (!authorizedBearer(request.headers.get("authorization"), process.env.NOTIFICATION_CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  try {
    return Response.json(await processPendingEmailDeliveries());
  } catch (error) {
    logger.error({ event: "notifications.delivery_failed", err: error }, "Notification delivery invocation failed");
    return Response.json({ error: "Delivery unavailable" }, { status: 503 });
  }
}
