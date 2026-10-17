import { logger } from "@/lib/logger";
import { readOwnUnreadNotifications } from "@/lib/notifications/financial-notices";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    return Response.json({ unread: await readOwnUnreadNotifications() }, { headers });
  } catch {
    logger.error({ event: "notifications.unread_read_failed" }, "Failed to check unread notifications");
    return Response.json({ message: "Unable to check notifications." }, { status: 503, headers });
  }
}
