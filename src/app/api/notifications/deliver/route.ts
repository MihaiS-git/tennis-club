import { createHash, timingSafeEqual } from "node:crypto";
import { deliverPendingBookingNotifications } from "@/lib/notifications/booking-delivery";
import { logger } from "@/lib/logger";

// Supabase Cron (pg_cron + pg_net) posts here every five minutes with a dedicated
// server-to-server secret. It only retries queued booking emails through the
// existing delivery service; it never runs payment, refund or booking work.
// One bounded batch per call: up to 10 emails within a 25-second budget (each
// Brevo request has a five-second timeout), well inside maxDuration.
export const maxDuration = 60;
const batchSize = 10, budgetMilliseconds = 25_000;

const digest = (value: string) => createHash("sha256").update(value).digest();
function authorized(header: string | null, secret: string) {
  const presented = header?.match(/^Bearer (\S+)$/)?.[1];
  // Equal-length digests keep the comparison constant-time for any input.
  return presented !== undefined && timingSafeEqual(digest(presented), digest(secret));
}

export async function POST(request: Request) {
  const secret = process.env.NOTIFICATION_CRON_SECRET?.trim();
  if (!secret || secret.length < 32) {
    logger.error({ event: "notifications.cron_not_configured" }, "NOTIFICATION_CRON_SECRET (32+ characters) is required");
    return new Response("Notification delivery is not configured", { status: 503 });
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    logger.warn({ event: "notifications.cron_unauthorized" }, "Rejected notification delivery request");
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const result = await deliverPendingBookingNotifications({ limit: batchSize, deadline: Date.now() + budgetMilliseconds });
  // Counts only: never recipients, message content or provider responses.
  if (result.interrupted) {
    logger.error({ event: "notifications.cron_failed", checked: result.checked, failed: result.failed }, "Scheduled notification delivery failed");
    return Response.json({ checked: result.checked, failed: result.failed }, { status: 503 });
  }
  if (result.failed) logger.warn({ event: "notifications.cron_partial", checked: result.checked, failed: result.failed },
    "Scheduled notification delivery left emails queued");
  return Response.json({ checked: result.checked, failed: result.failed });
}
