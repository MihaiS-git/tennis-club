import { messageAccess, unreadOwnMessageCount } from "@/lib/notifications/inbox";
import { logger } from "@/lib/logger";

const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  const access = await messageAccess();
  if (access.state === "unauthenticated") return Response.json({ error: "Authentication required" }, { status: 401, headers });
  if (access.state !== "ready") return Response.json({ error: "Account unavailable" }, { status: 503, headers });
  try { return Response.json({ unreadCount: await unreadOwnMessageCount(access.userId) }, { headers }); }
  catch {
    logger.error({ event: "messages.unread_count_failed" }, "Failed to load unread notification count");
    return Response.json({ error: "Unable to load unread count" }, { status: 503, headers });
  }
}
