import "server-only";

import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { lockDeliveryForProviderEvent, recordProviderDeliveryEvent } from "@/lib/db/repositories/booking-notifications.repository";
import { parseBrevoSubmissionReference } from "@/lib/mail/brevo";

// Brevo transactional email events that describe delivery. Others (request,
// opened, click, spam, unsubscribed, proxy opens) are accepted and ignored.
// deferred is a temporary delay that Brevo keeps retrying: never a failure.
const outcomes = {
  delivered: "delivered", deferred: "deferred",
  soft_bounce: "failed", hard_bounce: "failed", invalid_email: "failed", blocked: "failed", error: "failed",
} as const;
export type ProviderOutcome = typeof outcomes[keyof typeof outcomes];

const timestamp = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)])
  .pipe(z.number().positive().finite()).optional();
const eventSchema = z.object({
  event: z.string().max(64),
  "message-id": z.string().trim().min(1).max(998).optional(),
  "X-Mailin-custom": z.string().max(1000).optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  ts_epoch: timestamp, ts_event: timestamp, ts: timestamp,
});
// Brevo sends one event per request, or an array when the webhook is batched.
const payloadSchema = z.union([eventSchema, z.array(eventSchema).min(1).max(500)]);

export type BrevoDeliveryEvent = {
  messageId: string; submissionKey: string | null; event: keyof typeof outcomes; outcome: ProviderOutcome;
  reason: string | null; occurredAt: number;
};

// Delivery events need a message id and an event time; relevant malformed events
// make the whole payload invalid so it is never half-applied. null: invalid payload.
export function parseBrevoWebhookPayload(input: unknown): { events: BrevoDeliveryEvent[]; ignored: number } | null {
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) return null;
  const events: BrevoDeliveryEvent[] = [];
  let ignored = 0;
  for (const item of Array.isArray(parsed.data) ? parsed.data : [parsed.data]) {
    if (!Object.hasOwn(outcomes, item.event)) { ignored++; continue; }
    const event = item.event as keyof typeof outcomes;
    // ts_epoch is milliseconds; ts_event and ts are seconds. All are UTC.
    const occurredAt = item.ts_epoch ?? (item.ts_event ?? item.ts ?? NaN) * 1000;
    if (!item["message-id"] || !Number.isFinite(occurredAt)) return null;
    // The reason is shown to Admins only: single line, bounded, no control characters.
    const reason = item.reason?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500) || null;
    events.push({ messageId: item["message-id"], submissionKey: parseBrevoSubmissionReference(item["X-Mailin-custom"]),
      event, outcome: outcomes[event], reason, occurredAt: Math.round(occurredAt) });
  }
  return { events, ignored };
}

// Out-of-order and duplicate handling for one message. Brevo's final outcomes
// (delivered, failed) replace a pending deferral whenever they arrive; between
// final outcomes only a strictly later event wins, so a redelivered or older event
// changes nothing. A deferral never replaces a final outcome.
export function shouldApplyProviderEvent(current: { status: ProviderOutcome | null; occurredAt: number | null },
  next: { outcome: ProviderOutcome; occurredAt: number }) {
  if (current.status === null || current.occurredAt === null) return true;
  if (next.outcome === "deferred") return current.status === "deferred" && next.occurredAt > current.occurredAt;
  return current.status === "deferred" || next.occurredAt > current.occurredAt;
}

export type ProviderEventResult = "applied" | "duplicate" | "unknown";

// One short transaction per event, with the delivery row locked; no network
// request runs inside it. Events for earlier submissions, dismissed (deleted)
// deliveries or other senders are unknown and change nothing; Brevo never
// creates or restores a delivery record. A failure is shown to Admins and is
// never resent automatically.
export async function recordBrevoDeliveryEvent(event: BrevoDeliveryEvent): Promise<ProviderEventResult> {
  return inTransaction(async manager => {
    const delivery = await lockDeliveryForProviderEvent(manager, event);
    if (!delivery) return "unknown";
    if (!shouldApplyProviderEvent({ status: delivery.provider_status, occurredAt: delivery.provider_event_at }, event)) return "duplicate";
    await recordProviderDeliveryEvent(manager, { id: delivery.id, messageId: event.messageId, status: event.outcome,
      event: event.event, reason: event.reason, occurredAt: event.occurredAt });
    return "applied";
  });
}
