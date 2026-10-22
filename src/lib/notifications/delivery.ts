import "server-only";

import { inTransaction } from "@/lib/db/transaction";
import { claimEmailDeliveries, completeEmailAttempt, failExpiredFinalClaims,
  insertEmailFailureAlerts, type ClaimedEmail } from "@/lib/db/repositories/notifications.repository";
import { brevoConfig, sendBrevoEmail, type BrevoConfig } from "./brevo";
import { z } from "zod";

const retryMinutes = [5, 15, 60, 360] as const;
export type DeliverySummary = { claimed: number; accepted: number; sandboxAccepted: number; retried: number;
  failed: number; stale: number };

async function processClaim(config: BrevoConfig, delivery: ClaimedEmail): Promise<"accepted" | "sandboxAccepted" | "retried" | "failed" | "stale"> {
  const result = await sendBrevoEmail(config, delivery);
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
    if (status === "failed") await insertEmailFailureAlerts(manager, delivery.id, now);
    return status === "sandbox_accepted" ? "sandboxAccepted" : status === "pending" ? "retried" : status;
  });
}

export async function processPendingEmailDeliveries(): Promise<DeliverySummary> {
  // Configuration is checked before claiming; a bad deployment cannot consume attempts.
  const config = brevoConfig();
  const cutoff = process.env.NOTIFICATION_DELIVERY_NOT_BEFORE?.trim();
  const notBefore = cutoff ? new Date(z.iso.datetime({ offset: true }).parse(cutoff)) : null;
  const { claims, expired } = await inTransaction(async (manager) => {
    const expired = await failExpiredFinalClaims(manager, 20);
    for (const id of expired) await insertEmailFailureAlerts(manager, id, new Date());
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
