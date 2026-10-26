import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { readClubSettings, emailDispatchAllowed } from "@/lib/db/repositories/club-settings.repository";
import { inTransaction } from "@/lib/db/transaction";
import { claimEmailDeliveries, completeEmailAttempt, failExpiredFinalClaims,
  insertUserMessages, listActiveUserIdsWithRole, type ClaimedEmail } from "@/lib/db/repositories/notifications.repository";
import { brevoConfig, sendBrevoEmail, type BrevoConfig } from "./brevo";
import { deliveryCutoff } from "./delivery-retry";

const retryMinutes = [5, 15, 60, 360] as const;
export type DeliverySummary = { claimed: number; accepted: number; sandboxAccepted: number; retried: number;
  failed: number; stale: number };

// Operational alerts are in-app only: one message per failed delivery for every active Admin.
// Callers pass deliveries they just failed in the same transaction. Sorted keys give
// concurrent replays one insert order; (user_id, event_key) conflicts are ignored.
export async function recordEmailFailureAlerts(manager: EntityManager, deliveryIds: readonly string[], occurredAt: Date) {
  const ids = [...new Set(deliveryIds)].sort();
  if (ids.length === 0) return;
  const adminIds = await listActiveUserIdsWithRole(manager, "admin");
  await insertUserMessages(manager, ids.flatMap((deliveryId) => adminIds.map((userId) => ({
    id: randomUUID(), userId, eventKey: `email.delivery-failed:${deliveryId}`, kind: "email.delivery_failed",
    subject: "Booking email delivery failed",
    bodyText: "An outbound booking email could not be delivered. Open Delivery details to review the failure and retry eligibility.",
    href: null, createdAt: occurredAt }))));
}

export async function processClaim(config: BrevoConfig, delivery: ClaimedEmail): Promise<"accepted" | "sandboxAccepted" | "retried" | "failed" | "stale"> {
  const settings = await inTransaction(manager => emailDispatchAllowed(manager, delivery.id));
  if (!settings) return "stale";
  const result = await sendBrevoEmail({ ...config, sender: settings.officialEmail, senderName: settings.senderName }, delivery);
  const now = new Date();
  const status = result.ok ? (config.mode === "sandbox" ? "sandbox_accepted" : "accepted")
    : result.retryable && delivery.attempts < 5 ? "pending" : "failed";
  const nextAttemptAt = status === "pending"
    ? new Date(now.getTime() + retryMinutes[delivery.attempts - 1] * 60_000) : now;
  return inTransaction(async (manager) => {
    const updated = await completeEmailAttempt(manager, { id: delivery.id, attempts: delivery.attempts,
      lockedUntil: delivery.lockedUntil, status, nextAttemptAt,
      providerMessageId: result.ok ? result.messageId : null, lastError: result.ok ? null : result.error });
    if (!updated) return "stale";
    if (status === "failed") await recordEmailFailureAlerts(manager, [delivery.id], now);
    return status === "sandbox_accepted" ? "sandboxAccepted" : status === "pending" ? "retried" : status;
  });
}

export async function processPendingEmailDeliveries(): Promise<DeliverySummary> {
  // Configuration is checked before claiming; a bad deployment cannot consume attempts.
  const settings = await inTransaction(manager => readClubSettings(manager, "pessimistic_read"));
  if (!settings.emailsEnabled) return { claimed: 0, accepted: 0, sandboxAccepted: 0, retried: 0, failed: 0, stale: 0 };
  const config = brevoConfig(settings);
  const notBefore = deliveryCutoff();
  const { claims, expired } = await inTransaction(async (manager) => {
    if (!(await readClubSettings(manager, "pessimistic_read")).emailsEnabled) return { claims: [], expired: [] };
    const expired = await failExpiredFinalClaims(manager, 20);
    if (expired.length > 0) await recordEmailFailureAlerts(manager, expired, new Date());
    const claims = await claimEmailDeliveries(manager, 20 - expired.length, notBefore);
    return { claims, expired };
  });
  const summary: DeliverySummary = { claimed: claims.length, accepted: 0, sandboxAccepted: 0,
    retried: 0, failed: expired.length, stale: 0 };
  // Five concurrent four-second HTTP deadlines keep a full batch within one invocation.
  for (let offset = 0; offset < claims.length; offset += 5) {
    const results = await Promise.all(claims.slice(offset, offset + 5).map((claim) => processClaim(config, claim)));
    for (const result of results) summary[result]++;
  }
  return summary;
}
