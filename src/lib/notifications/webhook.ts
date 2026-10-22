import "server-only";

import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { failEmailFromWebhook, insertEmailFailureAlerts } from "@/lib/db/repositories/notifications.repository";

const eventSchema = z.object({ event: z.string(), email: z.email(), "message-id": z.string().min(1),
  reason: z.string().optional(), "X-Mailin-custom": z.string().optional() });
const eventTypeSchema = z.object({ event: z.string() });
const terminalEvents = new Set(["hard_bounce", "invalid", "invalid_email", "blocked"]);

export async function processBrevoFailureWebhook(payload: unknown): Promise<"ignored" | "failed" | "duplicate"> {
  if (!terminalEvents.has(eventTypeSchema.parse(payload).event)) return "ignored";
  const event = eventSchema.parse(payload);
  const correlation = event["X-Mailin-custom"]?.match(/(?:^|[;\s])email_delivery_id:([0-9a-f-]{36})(?:$|[;\s])/i);
  const reason = `${event.event}${event.reason ? `: ${event.reason}` : ""}`.slice(0, 1000);
  return inTransaction(async (manager) => {
    const id = await failEmailFromWebhook(manager, { recipientEmail: event.email,
      messageId: event["message-id"], deliveryId: correlation?.[1] ?? null, reason });
    if (!id) return "duplicate";
    await insertEmailFailureAlerts(manager, id, new Date());
    return "failed";
  });
}
